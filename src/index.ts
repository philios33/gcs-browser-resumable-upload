
type State = "NOT_STARTED" | "UPLOADING" | "BACKOFF" | "SUCCESSFUL" | "FAILED" | "CANCELLED";

import CRC32C, { buf } from "crc-32/crc32c";
import base64 from "base-64";

export class GCSResumableUpload {

    // abortController: AbortController; // No longer using fetch API
    // isStarted: boolean; // Use currentState
    // isCancelled: boolean; // Use currentState
    private sessionURI: string;
    private localFile: File;
    private crc32cb64: null | string;
    private onProgressHandlers: Array<(percent: number) => void>;
    private currentProgress: number;
    private currentState: State;
    private onStateChangeHandlers: Array<(newState: State) => void>;
    private xhr: XMLHttpRequest | null; // Keep track of this so we can abort the current request

    constructor(sessionURI: string, localFile: File) {
        this.sessionURI = sessionURI;
        this.localFile = localFile;
        this.onProgressHandlers = [];
        this.onStateChangeHandlers = [];
        // this.abortController = new AbortController();
        // this.isStarted = false;
        // this.isCancelled = false;
        this.currentState = "NOT_STARTED" as State;
        this.currentProgress = 0;
        this.xhr = null;
        this.crc32cb64 = null;
    }

    async calculateChecksum() {
        // console.log("Calculating checksum...");
        const buf = await this.localFile.arrayBuffer();
        const arr = new Uint8Array(buf);
        const chksum = CRC32C.buf(arr);
        // console.log("chksum", chksum);

        let fixedChksum = chksum;
        if (fixedChksum < 0) {
            // First bit is sign bit
            // fixedChksum = (chksum * -1) + Math.pow(2, 31);
            // But really it's 2s complement signed
            fixedChksum = chksum + Math.pow(2, 32);
        }
        // console.log("fixedChksum", fixedChksum);

        const chksumHex = fixedChksum.toString(16);
        // console.log("chksumHex", chksumHex);
        let dataBuf = "";
        for(let i = 0; i < chksumHex.length; i++) {
            dataBuf += !(i - 1 & 1) ? String.fromCharCode(parseInt(chksumHex.substring(i - 1, i + 1), 16)) : ""
        }
        // console.log("DATA BUF", dataBuf);
        const b64crc = base64.encode(dataBuf);
        this.crc32cb64 = b64crc;
        console.log("CRC32C is: " + b64crc + " (" + chksumHex + ")");
    }

    cancel() {
        if (this.currentState !== "CANCELLED") {
            this.fireNewState("CANCELLED");
            if (this.xhr !== null) {
                this.xhr.abort();
            }
            // this.abortController.abort();
        }
    }

    async start() { // Callers shouldn't await for the promise unless they want to.
        if (this.currentState !== "NOT_STARTED") {
            throw new Error("Started already");
        }
        
        // This step is required for consistancy checks
        await this.calculateChecksum();

        this.fireNewState("UPLOADING");
        const finalState = ["CANCELLED", "FAILED", "SUCCESSFUL"];

        try {
            console.log("TODO, prepare and do the upload", this.localFile);
            // It is not necessary to check the status yet

            if (this.localFile.stream) {
                console.log("Using File Stream");
                // Chrome is using 64Kb as streaming chunk size when reading local files
                // This is a bit small for upload chunk size.  We can continue to buffer the file until is reaches a max size, or it takes too long to read.
                const maxReadTime = 1000; // 1 second
                const maxBufferSize = 8 * 1024 * 1024; // 8MiB (For testing, but this could be up to 80MB really)
                // Note, we shouldn't go above 80MB per upload because it could hog browser memory
                // BEWARE: We must make sure the chunk is a multiple of 256K (262144) which probably means we will need to slice

                let buffers: Array<Uint8Array> = [];
                let bufferSize = 0;
                let offset = 0;
                let startMs = (new Date()).getTime();

                const flushBuffer = async (isFinal: boolean) => {
                    if (bufferSize > 0) {
                        // Create large chunk from all buffered chunks
                        // Making sure that the chunk size is a multiple of 256K
                        let newBufferSize = bufferSize;
                        if (!isFinal) {
                            const chunk256 = Math.floor(bufferSize / (256 * 1024));
                            const max256Size = chunk256 * 256 * 1024;
                            console.log("Buffer size", bufferSize, "so chunk should be " + chunk256 + " * 256K ", max256Size);
                            newBufferSize = max256Size;
                        }
                        const concatBuffer = new Uint8Array(newBufferSize);
                        let bufOffset = 0;
                        let recycledBuffers: Array<Uint8Array> = [];
                        let recycledSize = 0;
                        for (const buf of buffers) {

                            if (!isFinal && bufOffset === newBufferSize) {
                                // console.log("Already at correct size");
                                // Already at the correct size, recycle buffer
                                recycledBuffers.push(buf);
                                recycledSize += buf.byteLength;
                            } else {
                                // console.log("There is more space, fill up using next buffer");
                                // Is this next buffer going to breach the max size?
                                if (!isFinal && (buf.byteLength + bufOffset) > newBufferSize) {
                                    // Yes, it will breach, need to trim it
                                    const remaining = newBufferSize - bufOffset;
                                    // console.log("Next will breach, slicing " + remaining + " of " + buf.byteLength);

                                    const useData = buf.slice(0, remaining);
                                    const recycleData = buf.slice(remaining);
                                    concatBuffer.set(new Uint8Array(useData), bufOffset);
                                    bufOffset += useData.byteLength;
                                    // Don't forget to recycle the non used section
                                    recycledBuffers.push(recycleData);
                                    recycledSize += recycleData.byteLength;
                                } else {
                                    // Use the whole buffer
                                    // console.log("Using the whole buffer " + buf.byteLength + " total is " + bufOffset + "/" + newBufferSize);
                                    concatBuffer.set(new Uint8Array(buf), bufOffset);
                                    bufOffset += buf.byteLength;
                                }                                
                            }
                        }
                        // Clean the buffers
                        buffers = recycledBuffers;
                        bufferSize = recycledSize;
                        // console.log("Recycling " + bufferSize + " bytes for next chunk");

                        // Handle the large chunk
                        await this.handleChunk(offset, concatBuffer);
                        if (finalState.indexOf(this.currentState) === -1) {
                            offset += concatBuffer.byteLength;
                            // console.log("Handled " + offset + " of " + this.localFile.size + " total bytes");
                        }
                    }
                }
                const stream = this.localFile.stream();
                const reader = stream.getReader();
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }
                    // A chunk was read
                    const nowMs = (new Date()).getTime();
                    const age = nowMs - startMs;
                    buffers.push(new Uint8Array(value));
                    bufferSize += value.byteLength;
                    // console.log("Buffer size " + buffers.length + " at age " + age + " is: " + bufferSize);
                    let flush = false;
                    if (bufferSize > maxBufferSize) {
                        // Send this as a single chunk
                        // console.log("Buffer max size breached, flushing...");
                        flush = true;
                    } else if (age > maxReadTime) {
                        // console.log("Max read time breached, flushing...");
                        flush = true;
                    }

                    if (flush) {
                        await flushBuffer(false);
                        startMs = (new Date()).getTime(); // Reset the timer so we count from 0 again
                    }
                    if (finalState.indexOf(this.currentState) !== -1) {
                        return;
                    }
                }
                if (finalState.indexOf(this.currentState) !== -1) {
                    return;
                }

                await flushBuffer(true);
                

            } else {
                console.log("Old browser, using manual chunking");
                const chunksize = 8 * 1024 * 1024; // 8MB upload chunks
                let offset = 0;
                while( offset < this.localFile.size ) {
                    const chunkfile = await this.localFile.slice( offset, offset + chunksize );
                    // Blob.arrayBuffer() can be polyfilled with a FileReader
                    if (chunkfile.arrayBuffer) {
                        const chunk = await chunkfile.arrayBuffer();
                        await this.handleChunk(offset, chunk);
                    } else {
                        const chunk = await new Response(chunkfile).arrayBuffer();
                        await this.handleChunk(offset, chunk);
                    }
                    offset += chunksize;

                    if (finalState.indexOf(this.currentState) !== -1) {
                        return;
                    }
                }
            }

            if (finalState.indexOf(this.currentState) !== -1) {
                return;
            }

            // We've done all the uploading, now get the status to double check the hash
            const status = await this.getUploadStatus();
            if (status.complete) {
                this.finalDataStored(status.response.crc32, parseInt(status.response.size));
            } else {
                throw new Error("We've finished uploading data, but status isnt returning as complete");
            }
        } catch(e) {
            console.error(e);
            console.log("Error caught");
            this.fireNewState("FAILED");
        }
    }

    private async handleChunk(offset: number, buffer: ArrayBuffer): Promise<void> {
        const finalState = ["CANCELLED", "FAILED", "SUCCESSFUL"];
        // console.log("Handling chunk, offset: " + offset + " size: " + buffer.byteLength);
        // console.log("Should take file size to: " + (offset + buffer.byteLength));
        
        // TODO Now we can focus on uploading and retrying 
        // just this chunk buffer
        // We want large buffers so we do less requests, 
        // but this means checking the status endpoint more often on disconnect.
        // Chunking is triggering at 8MB so hopefully we can avoid doing the status checks.

        // This promise should never reject on communications issues, 
        // but it should reject if there is some error with the service

        // The promise will resolve only when the whole chunk has been put to the session URI

        
        // try {
            // Note, we dont need to worry about timeouts with an abort controller 
            // because we dont know how long a PUT request will take, the chunk could be quite large
            // BUT we will need an abort controller later to cancel the upload
            while (true) {

                const chunkSize = buffer.byteLength;
                const chunkStart = offset;
                const chunkStop = offset + chunkSize - 1;
                const headers = {
                    "Content-Length": chunkSize.toString(),
                    "Content-Range": "bytes " + chunkStart + "-" + chunkStop + "/" + this.localFile.size,
                }
                // Note, I am avoiding fetch here because it does not yet support upload progress with streams
                /*
                const result = await fetch(this.sessionURI, {
                    headers,
                    method: "PUT",
                    body: value,
                    signal: this.abortController.signal,
                });

                if (this.isCancelled) {
                    return; // This is detected properly after this promise resolves
                }
                */

                const endByte = offset + buffer.byteLength;
                // console.log("Uploading bytes " + offset + "-" + endByte + " ...");
                // Using XMLHttpRequest instead
                
                const result: {status: number, statusText: string, data: any} = await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    this.xhr = xhr;
                    xhr.upload.addEventListener("progress", (event) => {
                    if (event.lengthComputable) {
                        console.log("upload progress:", event.loaded, event.total);
                        this.logUploadProgress(offset + event.loaded, this.localFile.size);
                    }
                    });
                    /*
                    xhr.addEventListener("progress", (event) => {
                    if (event.lengthComputable) {
                        console.log("download progress:", event.loaded / event.total);
                    }
                    });
                    */
                    xhr.addEventListener("loadend", () => {
                        if (xhr.readyState === 4) {
                            this.xhr = null;
                            resolve({
                                status: xhr.status,
                                statusText: xhr.statusText,
                                data: xhr.responseText,
                            });
                        }
                    });
                    xhr.addEventListener("error", (event) => {
                        // Something went wrong, retry
                        console.warn(event);
                        this.xhr = null;
                        resolve({
                            status: 0,
                            statusText: event.type,
                            data: "",
                        });
                    });
                    xhr.addEventListener("timeout", () => {
                        // Timed out, retry
                        console.warn("Timeout detected");
                        this.xhr = null;
                        resolve({
                            status: 0,
                            statusText: "Timed out",
                            data: "",
                        });
                    });
                    xhr.addEventListener("abort", () => {
                        // Abort detected, retry
                        console.warn("Abort detected");
                        this.xhr = null;
                        resolve({
                            status: 0,
                            statusText: "Aborted",
                            data: "",
                        });
                    });
                    xhr.open("PUT", this.sessionURI, true);
                    xhr.setRequestHeader("Content-Range", headers["Content-Range"]);
                    // Note: This is a good way to simulate disconnect during development.
                    // Upload for a bit, then timeout and it should retry and fetch status
                    // We shouldn't set timeout in production because we dont know how long the upload will take
                    // xhr.timeout = 500;
                    // xhr.timeout = 60 * 1000; // 1 minute max upload to avoid pending bugs

                    xhr.send(buffer);
                });
                
                if (result.status === 308) {
                    // OK continue
                    return;
                } else if (result.status == 200 || result.status === 201) {
                    // We don't know if google thinks we have finished yet...
                    // const responseData = JSON.parse(result.data);
                    // this.finalDataStored(responseData.crc32c);
                    const isLastRequest = (chunkStop + 1) === this.localFile.size;
                    if (isLastRequest) {
                        // console.log("The last request");
                        const responseData = JSON.parse(result.data);
                        this.finalDataStored(responseData.crc32c, parseInt(responseData.size));
                    }
                    return;
                
                } else if (result.status >= 400 && result.status <= 499) {
                    // Non recoverable
                    throw new Error("Non recoverable status " + result.status + ": " + result.statusText);
                } else {
                    console.log("AUTO RECOVERY NEEDED HERE");
                    console.log("Status of PUT was", result.status, result.statusText);
                    console.log("OUTPUT OF PUT WAS", result.data);
                    // This is where we need to auto recover

                    while (true) {
                        console.log(new Date(), "BACKOFF...");
                        this.fireNewState("BACKOFF");

                        await this.backOff(); // Pause for appropriate amount of time and retry

                        // Check for a final state here
                        if (finalState.indexOf(this.currentState) !== -1) {
                            console.log("We are in a final state, stopping...");
                            return;
                        }

                        // Resume the upload by checking how much of it is done and manipulating the buffer and offset
                        try {
                            console.log("Resuming the upload by checking the status...");
                            const status = await this.getUploadStatus();
                            if (status.complete) {
                                // Whole upload looks completed, not just this chunk
                                this.finalDataStored(status.response.crc32c, parseInt(status.response.size));
                                return;
                            } else {
                                // Need to do more uploading
                                console.log("We need to do more uploading...", status.range);
                                if (status.range) {
                                    // E.g. bytes=0-1310719
                                    const re = new RegExp("^bytes=0\-(\\d+)$");
                                    const matches = re.exec(status.range);
                                    if (matches) {
                                        const lastByte = parseInt(matches[1], 10);
                                        if (lastByte >= endByte) {
                                            // The service has more bytes already than this chunk represents
                                            // Just continue
                                            this.fireNewState("UPLOADING");
                                            return;
                                        } else if (lastByte > offset) {
                                            // The service has a partially uploaded chunk
                                            const lastByteOfChunk = lastByte - offset;
                                            const newBuffer = buffer.slice(lastByteOfChunk);
                                            const newOffset = lastByte;
                                            console.log("Sliced buffer from " + buffer.byteLength + " to " + newBuffer.byteLength + " because GCS has everything until " + lastByteOfChunk);

                                            buffer = newBuffer;
                                            offset = newOffset;
                                        }
                                    }
                                }
                            }

                            break;
                        } catch(e) {
                            console.warn(e);
                            console.warn("Couldnt resume upload");
                        }
                    }

                    this.fireNewState("UPLOADING");
                }
                

            }
        /*
        } catch(e) {
            // Perhaps this gets here on abortion too
            console.error(e);
            console.log("Error caught");
            throw e; // This will reject the chunk handler and fail the upload
        }
        */


    }

    private finalDataStored(crc32c, fileSize) {
        if (this.crc32cb64 === crc32c && this.localFile.size === fileSize) {
            // Success
            this.fireNewState("SUCCESSFUL");
        } else {
            // Failed
            console.warn("Expecting B64 CRC32C: " + this.crc32cb64 + " of size " + this.localFile.size + " but google reported " + crc32c + " of size " + fileSize);
            this.fireNewState("FAILED");
        }
    }

    private async getUploadStatus() {
        console.log("Fetching upload status...");
        
        const result: {status: number, statusText: string, data: any, range: any} = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            this.xhr = xhr;
            xhr.addEventListener("loadend", () => {
                if (xhr.readyState === 4) {
                    this.xhr = null;
                    resolve({
                        status: xhr.status,
                        statusText: xhr.statusText,
                        data: xhr.responseText,
                        range: xhr.getResponseHeader("range"),
                    });
                }
            });
            xhr.addEventListener("error", (event) => {
                // Something went wrong, retry
                console.warn(event);
                this.xhr = null;
                resolve({
                    status: 0,
                    statusText: event.type,
                    data: "",
                    range: "",
                });
            });
            xhr.addEventListener("timeout", () => {
                // Timed out, retry
                console.warn("Timeout detected");
                this.xhr = null;
                resolve({
                    status: 0,
                    statusText: "Timed out",
                    data: "",
                    range: "",
                });
            });
            xhr.addEventListener("abort", () => {
                // Abort detected, retry
                console.warn("Abort detected");
                this.xhr = null;
                resolve({
                    status: 0,
                    statusText: "Aborted",
                    data: "",
                    range: "",
                });
            });
            xhr.open("PUT", this.sessionURI, true);
            // Origin is not controllable
            // xhr.setRequestHeader("Origin", document.location.origin);
            // xhr.setRequestHeader("content-type", "");
            xhr.setRequestHeader("Content-Range", "bytes */" + this.localFile.size);
            xhr.timeout = 10 * 1000; // Check status shouldn't take longer than 10 seconds
            xhr.send(); // Send 0 bytes
        });
        console.log("Upload status response: " + result.status + " " + result.statusText);

        if (result.status === 200 || result.status === 201) {
            const responseData = JSON.parse(result.data);
            return {
                complete: true,
                response: responseData,
            }
        } else if (result.status === 308) {
            return {
                complete: false,
                range: result.range,
            }
        } else {
            throw new Error("Unknown response from status: " + result.status + " " + result.statusText);
        }
    }

    private async backOff() : Promise<void> {
        const delayMs = 10 * 1000;
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                resolve();
            }, delayMs);            
        });
    }

    private logUploadProgress(bytesSent: number, bytesTotal: number) {
        // Only fire events if the rounded percentage point is different to the current one
        const perthouDone = Math.floor((bytesSent / bytesTotal) * 1000);
        if (perthouDone !== this.currentProgress) {
            this.currentProgress = perthouDone; // Store perthou 1/1000
            this.fireProgress(perthouDone/10); // But fire percent value
        }
    }

    onProgress(handler: (percent: number) => void) {
        this.onProgressHandlers.push(handler);
    }

    private fireProgress(progress: number) {
        for (const handler of this.onProgressHandlers) {
            try {
                handler.call(this, progress);
            } catch(e) {
                console.error(e);
            }
        }
    }

    onStateChange(handler: (newState: State) => void) {
        this.onStateChangeHandlers.push(handler);
    }

    private fireNewState(newState: State) {
        if (this.currentState !== newState) {
            this.currentState = newState;
            for (const handler of this.onStateChangeHandlers) {
                try {
                    handler.call(this, newState);
                } catch(e) {
                    console.error(e);
                }
            }
        }
    }

}
