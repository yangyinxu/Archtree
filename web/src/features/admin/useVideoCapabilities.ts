import { useQuery } from '@tanstack/react-query';
import { readCapabilities, useAdminAccess } from './AdminAccess';

/** Observes the shell's verified capability without loading the workbench or starting a second refresh. */
export function useVideoCapabilities() {
  const access = useAdminAccess();
  return useQuery({ queryKey: ['admin-capabilities', access.viewerId, access.epoch], queryFn: () => readCapabilities(access.viewerId), enabled: false }).data?.videoUploads;
}
