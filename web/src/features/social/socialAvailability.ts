import { useQuery } from '@tanstack/react-query';
import { listenerCapabilitiesQuery } from '../../api/listenerCapabilities';

/**
 * Reads the public rollout switches. A pending, failed or older response fails
 * closed, so no entry point offers participation the server would reject.
 */
export const useSocialAvailability = () => {
  const social = useQuery(listenerCapabilitiesQuery()).data?.social;
  const socialEnabled = social?.enabled === true;
  return { socialEnabled, roomsEnabled: socialEnabled && social!.rooms };
};
