/** Whether a portfolio project appears on the public homepage. */
export type PortfolioVisibility = 'public' | 'hidden';

export const portfolioVisibilities: readonly PortfolioVisibility[] = ['public', 'hidden'];

export interface PortfolioProjectLink {
    label: string;
    href: string;
}

/**
 * One portfolio entry. Copy and links live in code and change through a
 * commit; administrators control only order and visibility.
 */
export interface PortfolioProject {
    slug: string;
    name: string;
    /** One line shown beside the name. */
    tagline: string;
    description: string;
    /** Short labels such as the platform or main stack. */
    tags: readonly string[];
    /** Phosphor icon name without the `ph-` prefix. */
    icon: string;
    link: PortfolioProjectLink | null;
    defaultVisibility: PortfolioVisibility;
}

/**
 * Every project the portfolio knows about, in its default order. A project
 * added here appears after the stored order with its default visibility.
 */
export const portfolioProjects: readonly PortfolioProject[] = [
    {
        slug: 'finitude',
        name: 'Finitude',
        tagline: 'Music listening on the web',
        description: 'Browse albums, artists, and playlists, play Audio and Video in one queue, and listen together with friends in shared rooms.',
        tags: ['Web', 'React', 'Node.js'],
        icon: 'music-notes',
        link: { label: 'Open Finitude', href: '/finitude' },
        defaultVisibility: 'public'
    },
    {
        slug: 'finitude-ios',
        name: 'Finitude for iOS',
        tagline: 'The native iPhone client',
        description: 'SwiftUI client for the same catalog, with offline downloads, background playback, and the shared Home and Library pages.',
        tags: ['iOS', 'SwiftUI'],
        icon: 'device-mobile',
        link: null,
        defaultVisibility: 'public'
    },
    {
        slug: 'finitude-android',
        name: 'Finitude for Android',
        tagline: 'The native Android client',
        description: 'Kotlin and Jetpack Compose client with one app-wide Media3 player, search, Album details, and Artist follow.',
        tags: ['Android', 'Jetpack Compose'],
        icon: 'android-logo',
        link: null,
        defaultVisibility: 'public'
    },
    {
        slug: 'naruto-mobile',
        name: 'Naruto Mobile',
        tagline: 'Bilibili comment triage',
        description: 'A Chrome extension collects comments in your own signed-in browser, and the Web portal screens and analyzes them with a language model.',
        tags: ['Web', 'Chrome extension', 'Windows'],
        icon: 'chat-circle-text',
        link: { label: 'Open Naruto', href: '/naruto' },
        defaultVisibility: 'public'
    },
    {
        slug: 'ootd',
        name: 'OOTD',
        tagline: 'A private digital wardrobe',
        description: 'Catalog the clothes you own or find online, then get daily outfit recommendations built from them.',
        tags: ['Web', 'Next.js'],
        icon: 't-shirt',
        link: { label: 'Open OOTD', href: 'https://ootd.kashewt.com' },
        // Stays hidden until ootd.kashewt.com is live.
        defaultVisibility: 'hidden'
    }
];

export const isPortfolioVisibility = (value: unknown): value is PortfolioVisibility =>
    value === 'public' || value === 'hidden';
