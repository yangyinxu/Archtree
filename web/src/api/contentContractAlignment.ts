import type * as Public from '../../../src/contracts/listenerV1';
import type { z } from 'zod';
import type * as Schemas from './contentSchemas';
import type { ListenerCollectionPage } from './collectionSchemas';

/** Bidirectional assignability plus identical keys catches omitted optional fields too. */
type SameShape<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? [keyof Left] extends [keyof Right]
      ? [keyof Right] extends [keyof Left] ? true : false
      : false
    : false
  : false;
type Assert<Matches extends true> = Matches;

/** Compiled by the Web build; changes to either side must preserve the complete DTO. */
export type ListenerContractAlignment = [
  Assert<SameShape<z.infer<typeof Schemas.listenerDateSchema>, Public.ListenerDate>>,
  Assert<SameShape<z.infer<typeof Schemas.catalogCreditSchema>, Public.ListenerCatalogCredit>>,
  Assert<SameShape<Schemas.ArtistSummary, Public.ListenerArtistSummary>>,
  Assert<SameShape<Schemas.OrganizationSummary, Public.ListenerOrganizationSummary>>,
  Assert<SameShape<Schemas.AlbumSummary, Public.ListenerAlbumSummary>>,
  Assert<SameShape<Schemas.AudioTrackSummary, Public.ListenerAudioTrackSummary>>,
  Assert<SameShape<Schemas.HomeSection, Public.ListenerHomeSection>>,
  Assert<SameShape<Schemas.ListenerHome, Public.ListenerHome>>,
  Assert<SameShape<Schemas.ListenerSearch, Public.ListenerSearch>>,
  Assert<SameShape<Schemas.ListenerAlbum, Public.ListenerAlbum>>,
  Assert<SameShape<Schemas.ListenerArtist, Public.ListenerArtist>>,
  Assert<SameShape<Schemas.ListenerOrganization, Public.ListenerOrganization>>,
  Assert<SameShape<Schemas.ListenerTrack, Public.ListenerTrack>>,
  Assert<SameShape<ListenerCollectionPage['pageItem'], Public.ListenerCollectionPage['pageItem']>>,
  Assert<SameShape<ListenerCollectionPage['items'][number], Public.ListenerCollectionPageRef>>,
  Assert<SameShape<ListenerCollectionPage['included'], Public.ListenerCollectionPage['included']>>,
  Assert<SameShape<ListenerCollectionPage, Public.ListenerCollectionPage>>
];
