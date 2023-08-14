# Google Cloud Storage (GCS) Browser Resumable Upload

Send your GCS Session URI to a trusted uploader and let their browser handle the file upload directly to Google API.

Google do not provide a client side uploader for their own API, but they do provide extensive API docs for their RESTful service.

https://cloud.google.com/storage/docs/performing-resumable-uploads

Single chunk mode has better performance than multiple chunk mode since it uses less requests.  The upload is still resumable from the point it failed at, which is checkable using the API.

## Basic usage

    import { GCSResumableUpload } from 'gcs-browser-resumable-upload';

    const fileInput = document.getElementById("fileInput");
    const sessionInput = document.getElementById("sessionInput");
    
    const uploader = new GCSResumableUpload(sessionInput.value, fileInput.files[0]);
    uploader.onProgress(function(percent) {
        console.log("Progress", percent);
    });
    uploader.onStateChange(function(newState) {
        console.log("New State", newState);
    });
    uploader.start();

## How it works

The library exports a class GCSResumableUpload.  You instantiate it for each resumable upload and provide a GCS resumable URI (AKA Session URI) and a File from an input form element.  The upload library does the rest.

Uploads are resumable and retry automatically.  No need for checksum storage in local storage since we can check which bytes were persisted even when the connection goes down.

Note: Make sure you initiate the resumable upload with the correct Origin header, or you will run in to CORS errors in the browser.

Bundle this package in to your frontend bundle, or use it as a script module.

### Generating a session URI
Generating the Session URI for the resumable upload requires that you are authenticated and have relevant access to the Google Cloud Storage API.  This is normally done server side using a service account, and you can use Googles node client libraries for this.  Transmission of the session URI should only be over a secure connection and to trusted parties.

    import {Storage} from '@google-cloud/storage';

    const storage = new Storage();
    const bucket = storage.bucket(bucketId);
    const file = bucket.file(path);
    const response = await file.createResumableUpload({
        origin: myOrigin
    });
    console.log(response);
    // ['https://storage.googleapis.com/upload/storage/xxxxx']
