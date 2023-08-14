
const express = require('express');
const app = express();
app.use("/dist-es5", express.static(__dirname + '/../dist-es5'));
app.use("/dist-es6", express.static(__dirname + '/../dist-es6'));
app.use("/dist", express.static(__dirname + '/../dist'));
app.use("/", express.static(__dirname + '/../demo', { index: 'index.html' }));
app.put("/put", (req, res) => {
    console.log("PUT", req.headers["content-range"], req.headers["content-length"]);
    if (req.headers["content-length"] === "0") {
        // Status check, Send 308 with Range header
        res.set("Range", "bytes 0-32");
        res.status(308);
        res.send("");
    } else {
        // There is content to put
        res.status(200);
        res.send("");
    }
});
app.listen(8080, () => {
    console.log("Listening on port 8080");
});