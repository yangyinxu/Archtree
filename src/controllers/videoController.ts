import { Request, Response, NextFunction } from 'express';
import * as mongoDb from 'mongodb';
import { getDb } from '../app';
import path from 'path';

const gridFsCollection: string = 'fs.files';

export const getVideo = async (req: Request, res: Response, next: NextFunction) => {
    // tell the server which part of the video to send back
    const range = req.headers.range;
    // if a range is not provided
    if (!range) {
        res.status(400).send('Requires Range header');
        return;
    }

    const db = getDb();
    db?.collection(gridFsCollection).findOne({}, (err: any, video: any) => {
        if (!video) {
            res.status(404).send('No video uploaded!');
            return;
        }

        const videoSize:number = video.length;
        // replace all non-digits with empty string
        const match = range?.match(/bytes=(\d+)-(\d+)/);
        const start = match ? parseInt(match[2], 10) : 0;
        // end is either the start + 1MB or the end of the video
        const end = videoSize - 1;
        const contentLength = end - start + 1;
        
        console.log("--------------------")
        console.log("range: " + range)
        console.log("videoSize: " + videoSize)
        console.log("start: " + start)
        console.log("end: " + end)
        console.log("contentLength: " + contentLength)

        const headers = {
            "Content-Range": `bytes ${start}-${end}/${videoSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": contentLength,
            "Content-Type": "video/mp4",
        };

        // HTTP Status 206 for Partial Content
        res.writeHead(206, headers);

        const bucket = new mongoDb.GridFSBucket(db);
        const downloadStream = bucket.openDownloadStreamByName('bigbuck', {
            start
        });
        // Stream the video chunk to the client
        downloadStream.pipe(res);
    });

}

export const getVideoById = async (req: Request, res: Response, next: NextFunction) => {
    console.log("getVideoById: " + req.params.videoId)

    // tell the server which part of the video to send back
    const range = req.headers.range;
    // if a range is not provided
    if (!range) {
        res.status(400).send('Requires Range header');
        return;
    }

    const db = getDb();
    db?.collection(gridFsCollection).findOne({}, (err: any, video: any) => {
        if (!video) {
            res.status(404).send('No video uploaded!');
            return;
        }

        const videoSize:number = video.length;
        // replace all non-digits with empty string
        const match = range?.match(/bytes=(\d+)-(\d+)/);
        const start = match ? parseInt(match[2], 10) : 0;
        // end is either the start + 1MB or the end of the video
        //const end = Math.min(start + CHUNK_SIZE, videoSize - 1);
        const end = videoSize - 1;
        const contentLength = end - start + 1;
        
        console.log("--------------------")
        console.log("range: " + range)
        console.log("videoSize: " + videoSize)
        console.log("start: " + start)
        console.log("end: " + end)
        console.log("contentLength: " + contentLength)

        const headers = {
            "Content-Range": `bytes ${start}-${end}/${videoSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": contentLength,
            "Content-Type": "video/mp4",
        };

        // HTTP Status 206 for Partial Content
        res.writeHead(206, headers);

        const bucket = new mongoDb.GridFSBucket(db);
        const downloadStream = bucket.openDownloadStreamByName('bigbuck', {
            start
        });
        // Stream the video chunk to the client
        downloadStream.pipe(res);
    });

}