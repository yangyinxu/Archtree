export type SessionDeviceType = 'mobile' | 'phone' | 'tablet' | 'computer' | 'unknown';

export interface SessionDeviceDescription {
    deviceName: string;
    deviceType: SessionDeviceType;
}

/** Converts bounded User-Agent metadata into labels suitable for account UI. */
export const describeSessionDevice = (
    userAgent?: string
): SessionDeviceDescription => {
    const value = String(userAgent ?? '').slice(0, 256);
    if (/Finitude_iOS|Finitude\/\S+.*(?:iOS|iPhone|iPad)/i.test(value)) {
        return { deviceName: 'iPhone or iPad', deviceType: 'mobile' };
    }

    const platform = (() => {
        if (/iPad/i.test(value)) return { name: 'iPad', type: 'tablet' as const };
        if (/iPhone|iPod/i.test(value)) return { name: 'iPhone', type: 'phone' as const };
        if (/Android/i.test(value)) {
            return /Mobile/i.test(value)
                ? { name: 'Android phone', type: 'phone' as const }
                : { name: 'Android tablet', type: 'tablet' as const };
        }
        if (/Macintosh|Mac OS X/i.test(value)) {
            return { name: 'Mac', type: 'computer' as const };
        }
        if (/Windows/i.test(value)) {
            return { name: 'Windows PC', type: 'computer' as const };
        }
        if (/Linux/i.test(value)) {
            return { name: 'Linux computer', type: 'computer' as const };
        }
        return null;
    })();

    const browser = (() => {
        if (/EdgiOS|EdgA|Edg\//i.test(value)) return 'Edge';
        if (/CriOS|Chrome\//i.test(value)) return 'Chrome';
        if (/FxiOS|Firefox\//i.test(value)) return 'Firefox';
        if (/Safari\//i.test(value)) return 'Safari';
        if (/Mozilla\//i.test(value)) return 'Web browser';
        return null;
    })();

    if (platform && browser) {
        return {
            deviceName: `${browser} on ${platform.name}`,
            deviceType: platform.type
        };
    }
    if (platform) {
        return {
            deviceName: platform.name,
            deviceType: platform.type
        };
    }
    return { deviceName: 'Unknown device', deviceType: 'unknown' };
};
