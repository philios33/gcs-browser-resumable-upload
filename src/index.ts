
type State = "NOT_STARTED" | "UPLOADING" | "BACKOFF" | "SUCCESSFUL" | "FAILED" | "CANCELLED";

export class GCSResumableUpload {

    // abortController: AbortController; // No longer using fetch API
    // isStarted: boolean; // Use currentState
    // isCancelled: boolean; // Use currentState
    private sessionURI: string;
    private localFile: File;
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

                let buffers: Array<Uint8Array> = [];
                let bufferSize = 0;
                let offset = 0;
                let startMs = (new Date()).getTime();

                const flushBuffer = async () => {
                    if (bufferSize > 0) {
                        // Create large chunk from all buffered chunks
                        const concatBuffer = new Uint8Array(bufferSize);
                        let bufOffset = 0;
                        for (const buf of buffers) {
                            concatBuffer.set(new Uint8Array(buf), bufOffset);
                            bufOffset += buf.byteLength;
                        }
                        // Clean the buffers
                        buffers = [];
                        bufferSize = 0;

                        // Handle the large chunk
                        await this.handleChunk(offset, concatBuffer);
                        offset += concatBuffer.byteLength;
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
                    console.log("Buffer size " + buffers.length + " at age " + age + " is: " + bufferSize);
                    let flush = false;
                    if (bufferSize > maxBufferSize) {
                        // Send this as a single chunk
                        console.log("Buffer max size breached, flushing...");
                        flush = true;
                    } else if (age > maxReadTime) {
                        console.log("Max read time breached, flushing...");
                        flush = true;
                    }

                    if (flush) {
                        await flushBuffer();
                        startMs = (new Date()).getTime(); // Reset the timer so we count from 0 again
                    }
                    if (finalState.indexOf(this.currentState) !== -1) {
                        break;
                    }
                }
                await flushBuffer();

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
                        break;
                    }
                }
            }

            if (finalState.indexOf(this.currentState) !== -1) {
                return;
            }
            
            this.fireNewState("SUCCESSFUL");
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

        const chunkSize = buffer.byteLength;
        const chunkStart = offset;
        const chunkStop = offset + chunkSize - 1;
        const headers = {
            "Content-Length": chunkSize.toString(),
            "Content-Range": "bytes " + chunkStart + "-" + chunkStop + "/*",
        }
        // try {
            // Note, we dont need to worry about timeouts with an abort controller 
            // because we dont know how long a PUT request will take, the chunk could be quite large
            // BUT we will need an abort controller later to cancel the upload
            while (true) {

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
                console.log("Uploading bytes " + offset + "-" + endByte + " ...");
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
                    xhr.timeout = 50;
                    xhr.send(buffer);
                });
                
                if (result.status == 200 || result.status === 201 || result.status === 308) {
                    // OK continue
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
                        this.fireNewState("BACKOFF");

                        await this.backOff(); // Pause for appropriate amount of time and retry

                        // Check for a final state here
                        if (finalState.indexOf(this.currentState) !== -1) {
                            return;
                        }

                        // Resume the upload by checking how much of it is done and manipulating the buffer and offset
                        try {
                            const status = await this.getUploadStatus();
                            if (status.complete) {
                                // Whole upload is good, not just this chunk
                                this.fireNewState("SUCCESSFUL");
                                return;
                            } else {
                                // Need to do more uploading
                                console.log("We need to do more uploading...", status.range);
                                if (status.range) {
                                    // TODO Parse Range, slice buffer and update offset if necessary
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
                        range: xhr.getResponseHeader("Range"),
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
            xhr.setRequestHeader("Content-Range", "bytes 0/" + this.localFile.size);
            xhr.timeout = 10 * 1000; // Check status shouldn't take longer than 10 seconds
            xhr.send(""); // Send 0 bytes
        });
        console.log("Upload status response: " + result.status + " " + result.statusText);

        if (result.status === 200 || result.status === 201) {
            return {
                complete: true,
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
            try {
                setTimeout(() => {
                    resolve();
                }, delayMs);
            } catch(e) {
                reject(e);
            }
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
