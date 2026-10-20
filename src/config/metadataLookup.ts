/**
 * Product token of the metadata-lookup User-Agent. MusicBrainz and Cover Art Archive requests add the
 * operator contact in parentheses; iTunes Search API requests send the token alone.
 */
export const metadataLookupClientProduct = 'Finitude/1.0';

export type MetadataLookupConfiguration =
    | { available: true; userAgent: string }
    | { available: false; reason: 'importsDisabled' | 'contactMissing' | 'contactInvalid' };

const emailContact = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const dottedHostname = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/**
 * A contact is one printable ASCII token, so it can never break out of the User-Agent comment:
 * an email address, or a credential-free `https:` URL on the default port with a dotted hostname.
 */
const validContact = (contact: string) => {
    if (contact.length < 3 || contact.length > 200 || !/^[\x21-\x7e]+$/.test(contact) || /[()"\\<>]/.test(contact)) return false;
    if (emailContact.test(contact)) return true;
    try {
        const url = new URL(contact);
        return url.protocol === 'https:' && !url.username && !url.password && url.port === ''
            && dottedHostname.test(url.hostname) && !/^[\d.]+$/.test(url.hostname);
    } catch { return false; }
};

/**
 * Lookup is unavailable, and sends nothing, unless imports are enabled and a valid operator contact
 * is set. The imports check mirrors `importEnabled()`, because config may not import administration.
 * The contact reaches only the MusicBrainz and Cover Art Archive User-Agent and is never logged.
 */
export const metadataLookupConfiguration = (environment: NodeJS.ProcessEnv = process.env): MetadataLookupConfiguration => {
    if (environment.FINITUDE_ADMIN_IMPORTS_ENABLED !== 'true') return { available: false, reason: 'importsDisabled' };
    const contact = environment.FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT?.trim();
    if (!contact) return { available: false, reason: 'contactMissing' };
    if (!validContact(contact)) return { available: false, reason: 'contactInvalid' };
    return { available: true, userAgent: `${metadataLookupClientProduct} ( ${contact} )` };
};
