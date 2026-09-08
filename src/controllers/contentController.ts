/** Stable route facade; implementation ownership lives in focused Catalog and Content Manager adapters. */
export {
    renderAudioTracksPageForWeb,
    renderManagePageForWeb,
    searchContentWeb,
    searchManagementReferencesWeb
} from './contentManager/queryController';
export {
    createOrganizationWeb,
    createOrganizationReleaseWeb,
    updateOrganizationWeb,
    deleteOrganizationWeb,
    addCatalogCreditWeb,
    removeCatalogCreditWeb,
    updateCatalogCreditRoleWeb,
    reorderCatalogCreditWeb,
    markCatalogAttributionUnknownWeb
} from './contentManager/creditController';
export {
    createArtistReleaseWorkflowWeb,
    retryArtistReleaseWorkflowWeb
} from './contentManager/releaseWorkflowController';
export {
    createArtistWeb,
    updateArtistWeb,
    updateArtistMetadataWeb,
    updateArtistCoverArtWeb,
    deleteArtistWeb,
    linkAlbumToArtistWeb,
    addArtistAlbumWeb,
    removeArtistAlbumWeb,
    linkTrackToArtistWeb
} from './contentManager/artistController';
export {
    createAlbumWeb,
    createArtistAlbumWeb,
    updateAlbumWeb,
    deleteAlbumWeb,
    linkTrackToAlbumWeb
} from './contentManager/albumController';
export {
    createAudioTrackWeb,
    updateAudioTrackWeb,
    deleteAudioTrackWeb,
    deleteAlbumAudioTracksWeb,
    uploadAudioTrackWeb,
    uploadSoundtrackVideoWeb,
    deleteSoundtrackVideoWeb,
    bulkUploadAudioTracksWeb
} from './contentManager/mediaController';
export { searchContent, getOrganization } from './catalogQueryController';
