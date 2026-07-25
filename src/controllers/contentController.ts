import { Request, Response, NextFunction } from 'express';
import { Artist } from '../models/artist';
import { Album } from '../models/album';
import { AudioTrack, AudioFormat } from '../models/audioTrack';
import { SimpleDate } from '../models/simpleDate';
import { AuthenticatedRequest, ensureOwnerOrAdmin } from '../middleware/authMiddleware';
import { getS3 } from '../app';

const escapeHtml = (value: string) => {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

const parseCsv = (value: string) => {
    return value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean) as [string];
};

const parseDateInput = (value: string) => {
    if (!value) {
        return new SimpleDate();
    }

    const [yearRaw, monthRaw, dayRaw] = value.split('-');
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);

    if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
        return new SimpleDate();
    }

    return new SimpleDate(year, month, day);
};

const renderSectionList = (title: string, items: any[], formatter: (item: any) => string) => {
    const content = items.length > 0
        ? items.map((item) => `<li>${formatter(item)}</li>`).join('')
        : '<li>None</li>';

    return `<h3>${title}</h3><ul>${content}</ul>`;
};

const renderManagePage = (params: {
    userEmail: string;
    message?: string;
    searchQuery?: string;
    selectedUploadTrackId?: string;
    artists?: any[];
    albums?: any[];
    audioTracks?: any[];
    ownedArtists?: any[];
    ownedAlbums?: any[];
    ownedAudioTracks?: any[];
}) => {
    const messageBlock = params.message
        ? `<p style="padding:10px;background:#eef9ff;border:1px solid #b3e5fc;border-radius:8px;">${escapeHtml(params.message)}</p>`
        : '';

    const searchQuery = escapeHtml(params.searchQuery ?? '');
    const artists = params.artists ?? [];
    const albums = params.albums ?? [];
    const audioTracks = params.audioTracks ?? [];
    const selectedUploadTrackId = escapeHtml(params.selectedUploadTrackId ?? '');

    const ownedArtists = params.ownedArtists ?? [];
    const ownedAlbums = params.ownedAlbums ?? [];
    const ownedAudioTracks = params.ownedAudioTracks ?? [];

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Archtree Content Manager</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 960px; margin: 32px auto; padding: 0 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 14px; }
    form { display: grid; gap: 8px; }
    input { padding: 8px; font-size: 14px; }
    button { padding: 8px 12px; cursor: pointer; }
    h2, h3 { margin-bottom: 8px; }
    code { background: #f3f3f3; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Content Manager</h1>
  <p>Signed in as <strong>${escapeHtml(params.userEmail)}</strong></p>
  <p><a href="/">Home</a> | <form style="display:inline;" method="POST" action="/auth/logout-web"><button type="submit">Log out</button></form></p>
  ${messageBlock}

  <div class="card">
    <h2>Unified Search</h2>
    <form method="GET" action="/content/manage/search">
      <input type="text" name="q" value="${searchQuery}" placeholder="Search artist, album, track" required />
      <button type="submit">Search</button>
    </form>
    ${renderSectionList('Artists', artists, (item) => `${escapeHtml(item.name ?? '')} (<code>${escapeHtml(String(item._id ?? ''))}</code>)`)}
    ${renderSectionList('Albums', albums, (item) => `${escapeHtml(item.title ?? '')} (<code>${escapeHtml(String(item._id ?? ''))}</code>)`)}
    ${renderSectionList('Audio Tracks', audioTracks, (item) => `${escapeHtml(item.title ?? '')} (<code>${escapeHtml(String(item._id ?? ''))}</code>)`)}
  </div>

  <h2>My Content</h2>
  <div class="card">
    ${renderSectionList('My Artists', ownedArtists, (item) => `${escapeHtml(item.name ?? '')} (<code>${escapeHtml(String(item._id ?? ''))}</code>)`)}
    ${renderSectionList('My Albums', ownedAlbums, (item) => `${escapeHtml(item.title ?? '')} (<code>${escapeHtml(String(item._id ?? ''))}</code>)`)}
        ${renderSectionList('My Audio Tracks', ownedAudioTracks, (item) => {
            const id = escapeHtml(String(item._id ?? ''));
            return `${escapeHtml(item.title ?? '')} (<code>${id}</code>) - <a href="/content/manage?uploadAudioTrackId=${id}">Use for upload</a>`;
        })}
  </div>

  <h2>Create</h2>
  <div class="grid">
    <div class="card">
      <h3>Create Artist</h3>
      <form method="POST" action="/content/manage/artist/create">
        <input name="name" placeholder="Name" required />
        <input name="birthDate" type="date" />
        <input name="bio" placeholder="Bio" />
        <input name="coverArtUrl" placeholder="Cover Art URL" />
        <input name="albumIds" placeholder="Album IDs (comma separated)" />
        <input name="audioTrackIds" placeholder="Audio Track IDs (comma separated)" />
        <button type="submit">Create Artist</button>
      </form>
    </div>

    <div class="card">
      <h3>Create Album</h3>
      <form method="POST" action="/content/manage/album/create">
        <input name="title" placeholder="Title" required />
        <input name="coverArtUrl" placeholder="Cover Art URL" />
        <input name="audioTrackIds" placeholder="Audio Track IDs (comma separated)" />
        <input name="releaseDate" type="date" />
        <button type="submit">Create Album</button>
      </form>
    </div>

    <div class="card">
      <h3>Create Audio Track</h3>
      <form method="POST" action="/content/manage/audioTrack/create">
        <input name="title" placeholder="Title" required />
        <input name="artistIds" placeholder="Artist IDs (comma separated)" />
        <input name="genres" placeholder="Genres (comma separated)" />
        <input name="albumId" placeholder="Album ID" />
        <input name="releaseDate" type="date" />
        <input name="duration" placeholder="Duration (e.g. 03:30)" />
        <input name="formatType" placeholder="Format type (e.g. MP3)" />
        <input name="formatBitrate" placeholder="Bitrate (e.g. 320)" />
        <input name="coverArtUrl" placeholder="Cover Art URL" />
        <button type="submit">Create Audio Track</button>
      </form>
    </div>
  </div>

  <h2>Update / Delete</h2>
  <div class="grid">
    <div class="card">
      <h3>Artist</h3>
      <form method="POST" action="/content/manage/artist/update">
        <input name="artistId" placeholder="Artist ID" required />
        <input name="name" placeholder="New Name (optional)" />
        <input name="bio" placeholder="New Bio (optional)" />
        <input name="coverArtUrl" placeholder="New Cover URL (optional)" />
        <button type="submit">Update Artist</button>
      </form>
      <form method="POST" action="/content/manage/artist/delete">
        <input name="artistId" placeholder="Artist ID" required />
        <button type="submit">Delete Artist</button>
      </form>
    </div>

    <div class="card">
      <h3>Album</h3>
      <form method="POST" action="/content/manage/album/update">
        <input name="albumId" placeholder="Album ID" required />
        <input name="title" placeholder="New Title (optional)" />
        <input name="coverArtUrl" placeholder="New Cover URL (optional)" />
        <button type="submit">Update Album</button>
      </form>
      <form method="POST" action="/content/manage/album/delete">
        <input name="albumId" placeholder="Album ID" required />
        <button type="submit">Delete Album</button>
      </form>
    </div>

    <div class="card">
      <h3>Audio Track</h3>
      <form method="POST" action="/content/manage/audioTrack/update">
        <input name="audioTrackId" placeholder="Audio Track ID" required />
        <input name="title" placeholder="New Title (optional)" />
        <input name="coverArtUrl" placeholder="New Cover URL (optional)" />
        <button type="submit">Update Audio Track</button>
      </form>
      <form method="POST" action="/content/manage/audioTrack/delete">
        <input name="audioTrackId" placeholder="Audio Track ID" required />
        <button type="submit">Delete Audio Track</button>
      </form>
            <hr />
            <h3>Upload Audio File</h3>
            <form method="POST" action="/content/manage/audioTrack/upload" enctype="multipart/form-data">
                <input name="audioTrackId" value="${selectedUploadTrackId}" placeholder="Audio Track ID" required />
                <input type="file" name="audioFile" accept="audio/*" required />
                <button type="submit">Upload File to S3</button>
            </form>
    </div>
  </div>
</body>
</html>`;
};

const getOwnerId = (doc: any) => {
    return String(doc?.createdBy ?? '');
};

const redirectWithMessage = (res: Response, message: string) => {
    res.redirect(`/content/manage?message=${encodeURIComponent(message)}`);
};

export const renderManagePageForWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const ownedByUser = authReq.auth.userId;
        const [ownedArtists, ownedAlbums, ownedAudioTracks] = await Promise.all([
            Artist.fetchByCreator(ownedByUser),
            Album.fetchByCreator(ownedByUser),
            AudioTrack.fetchByCreator(ownedByUser)
        ]);

        const message = String(req.query.message ?? '');
        const selectedUploadTrackId = String(req.query.uploadAudioTrackId ?? '');

        return res.status(200).send(renderManagePage({
            userEmail: authReq.auth.email,
            message,
            selectedUploadTrackId,
            ownedArtists,
            ownedAlbums,
            ownedAudioTracks
        }));
    } catch (error) {
        return next(error);
    }
};

export const searchContentWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const rawQuery = String(req.query.q ?? '').trim();
        const selectedUploadTrackId = String(req.query.uploadAudioTrackId ?? '');
        const parsedLimit = Number(req.query.limit ?? 10);
        const limit = Number.isNaN(parsedLimit) ? 10 : Math.max(1, Math.min(parsedLimit, 50));

        const [artists, albums, audioTracks, ownedArtists, ownedAlbums, ownedAudioTracks] = await Promise.all([
            rawQuery ? Artist.searchByName(rawQuery, limit) : Promise.resolve([]),
            rawQuery ? Album.searchByTitle(rawQuery, limit) : Promise.resolve([]),
            rawQuery ? AudioTrack.searchByTitle(rawQuery, limit) : Promise.resolve([]),
            Artist.fetchByCreator(authReq.auth.userId),
            Album.fetchByCreator(authReq.auth.userId),
            AudioTrack.fetchByCreator(authReq.auth.userId)
        ]);

        return res.status(200).send(renderManagePage({
            userEmail: authReq.auth.email,
            searchQuery: rawQuery,
            selectedUploadTrackId,
            artists,
            albums,
            audioTracks,
            ownedArtists,
            ownedAlbums,
            ownedAudioTracks
        }));
    } catch (error) {
        return next(error);
    }
};

export const createArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const artist = new Artist(
            String(req.body.name ?? ''),
            parseDateInput(String(req.body.birthDate ?? '')),
            String(req.body.bio ?? ''),
            String(req.body.coverArtUrl ?? ''),
            parseCsv(String(req.body.albumIds ?? '')),
            parseCsv(String(req.body.audioTrackIds ?? '')),
            authReq.auth.userId
        );

        await artist.save();
        return redirectWithMessage(res, 'Artist created successfully.');
    } catch (error) {
        return next(error);
    }
};

export const updateArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const artistId = String(req.body.artistId ?? '');
        const artist = await Artist.findById(artistId);
        if (!artist) {
            return redirectWithMessage(res, 'Artist not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(artist))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify this artist.');
        }

        const updatePayload: Record<string, unknown> = {};
        if (req.body.name) updatePayload.name = String(req.body.name);
        if (req.body.bio) updatePayload.bio = String(req.body.bio);
        if (req.body.coverArtUrl) updatePayload.coverArtUrl = String(req.body.coverArtUrl);

        await Artist.updateById(artistId, updatePayload);
        return redirectWithMessage(res, 'Artist updated successfully.');
    } catch (error) {
        return next(error);
    }
};

export const deleteArtistWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const artistId = String(req.body.artistId ?? '');
        const artist = await Artist.findById(artistId);
        if (!artist) {
            return redirectWithMessage(res, 'Artist not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(artist))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can delete this artist.');
        }

        await Artist.deleteById(artistId);
        return redirectWithMessage(res, 'Artist deleted successfully.');
    } catch (error) {
        return next(error);
    }
};

export const createAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const album = new Album(
            String(req.body.title ?? ''),
            String(req.body.coverArtUrl ?? ''),
            parseCsv(String(req.body.audioTrackIds ?? '')),
            parseDateInput(String(req.body.releaseDate ?? '')),
            authReq.auth.userId
        );

        await album.save();
        return redirectWithMessage(res, 'Album created successfully.');
    } catch (error) {
        return next(error);
    }
};

export const updateAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const albumId = String(req.body.albumId ?? '');
        const album = await Album.findById(albumId);
        if (!album) {
            return redirectWithMessage(res, 'Album not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(album))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify this album.');
        }

        const updatePayload: Record<string, unknown> = {};
        if (req.body.title) updatePayload.title = String(req.body.title);
        if (req.body.coverArtUrl) updatePayload.coverArtUrl = String(req.body.coverArtUrl);

        await Album.updateById(albumId, updatePayload);
        return redirectWithMessage(res, 'Album updated successfully.');
    } catch (error) {
        return next(error);
    }
};

export const deleteAlbumWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const albumId = String(req.body.albumId ?? '');
        const album = await Album.findById(albumId);
        if (!album) {
            return redirectWithMessage(res, 'Album not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(album))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can delete this album.');
        }

        await Album.deleteById(albumId);
        return redirectWithMessage(res, 'Album deleted successfully.');
    } catch (error) {
        return next(error);
    }
};

export const createAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const formatType = String(req.body.formatType ?? 'MP3');
        const bitrateRaw = String(req.body.formatBitrate ?? '').trim();
        const bitrate = bitrateRaw ? Number(bitrateRaw) : undefined;

        const track = new AudioTrack(
            String(req.body.title ?? ''),
            parseCsv(String(req.body.artistIds ?? '')),
            parseCsv(String(req.body.genres ?? '')),
            String(req.body.albumId ?? ''),
            parseDateInput(String(req.body.releaseDate ?? '')),
            String(req.body.duration ?? ''),
            new AudioFormat(formatType, Number.isNaN(bitrate as number) ? undefined : bitrate),
            String(req.body.coverArtUrl ?? ''),
            authReq.auth.userId
        );

        const createResult: any = await track.save();
        const newTrackId = String(createResult?.insertedId ?? '');
        const message = encodeURIComponent('Audio track created successfully. You can upload the file now.');
        const uploadQuery = newTrackId ? `&uploadAudioTrackId=${encodeURIComponent(newTrackId)}` : '';

        return res.redirect(`/content/manage?message=${message}${uploadQuery}`);
    } catch (error) {
        return next(error);
    }
};

export const updateAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const audioTrackId = String(req.body.audioTrackId ?? '');
        const track = await AudioTrack.findById(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'Audio track not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(track))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can modify this audio track.');
        }

        const updatePayload: Record<string, unknown> = {};
        if (req.body.title) updatePayload.title = String(req.body.title);
        if (req.body.coverArtUrl) updatePayload.coverArtUrl = String(req.body.coverArtUrl);

        await AudioTrack.updateById(audioTrackId, updatePayload);
        return redirectWithMessage(res, 'Audio track updated successfully.');
    } catch (error) {
        return next(error);
    }
};

export const deleteAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const audioTrackId = String(req.body.audioTrackId ?? '');
        const track = await AudioTrack.findById(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'Audio track not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(track))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can delete this audio track.');
        }

        await AudioTrack.deleteById(audioTrackId);

        try {
            await getS3().deleteObject({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: audioTrackId
            }).promise();
            return redirectWithMessage(res, 'Audio track deleted successfully.');
        } catch (s3Error) {
            console.log('S3 cleanup failed for audioTrackId:', audioTrackId, s3Error);
            return redirectWithMessage(res, 'Audio track deleted, but S3 file cleanup failed.');
        }
    } catch (error) {
        return next(error);
    }
};

export const uploadAudioTrackWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) {
            return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        }

        const audioTrackId = String(req.body.audioTrackId ?? '');
        const track = await AudioTrack.findById(audioTrackId);
        if (!track) {
            return redirectWithMessage(res, 'Audio track not found.');
        }

        if (!ensureOwnerOrAdmin(authReq, getOwnerId(track))) {
            return redirectWithMessage(res, 'Forbidden: only creator or admin can upload for this audio track.');
        }

        const uploadFile = (req as Request & { file?: Express.Multer.File }).file;
        if (!uploadFile) {
            return redirectWithMessage(res, 'Missing audio file.');
        }

        await getS3().upload({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: audioTrackId,
            Body: uploadFile.buffer,
            ContentType: uploadFile.mimetype || 'audio/mpeg'
        }).promise();

        return redirectWithMessage(res, 'Audio file uploaded successfully.');
    } catch (error) {
        return next(error);
    }
};

export const searchContent = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const rawQuery = String(req.query.q ?? '').trim();
        if (!rawQuery) {
            return res.status(400).json({ message: 'Missing required query parameter: q' });
        }

        const parsedLimit = Number(req.query.limit ?? 10);
        const limit = Number.isNaN(parsedLimit) ? 10 : Math.max(1, Math.min(parsedLimit, 50));

        const [artists, albums, audioTracks] = await Promise.all([
            Artist.searchByName(rawQuery, limit),
            Album.searchByTitle(rawQuery, limit),
            AudioTrack.searchByTitle(rawQuery, limit)
        ]);

        return res.status(200).json({
            query: rawQuery,
            artists,
            albums,
            audioTracks
        });
    } catch (error) {
        return next(error);
    }
};
