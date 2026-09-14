/** HTTP and WebSocket upgrades use the same bounded proxy-hop policy. Zero trusts no forwarded headers. */
export const configuredTrustProxyHops = (): number => {
    const value = Number(process.env.TRUST_PROXY_HOPS ?? 1);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1;
};
