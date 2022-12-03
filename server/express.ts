// Host demo at /
// Host dist at /dist

const express = require('express');
const app = express();
app.use("/dist-esm", express.static(__dirname + '/../../dist-esm'));
app.use("/dist-cjs", express.static(__dirname + '/../../dist-cjs'));
app.use("/", express.static(__dirname + '/../../demo', { index: 'index.html' }));
app.put("/put", (req, res) => {
    console.log("PUT", req.headers["content-range"], req.headers["content-length"]);
    if (req.headers["content-length"] === "0") {
        // Status check, Send 308 with Range header
        res.set("Range", "bytes 0-35/36");
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