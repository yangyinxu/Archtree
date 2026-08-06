import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { privateAvatarQuery, privateAvatarQueryKey } from '../api/avatar';
import { Icon } from './Icon';
import styles from './Avatar.module.css';

export const avatarInitials = (displayName: string, email: string) => {
  const source = displayName.trim() || email.trim();
  if (!source) return '';
  const words = source.split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join('').toLocaleUpperCase();
};

export interface AvatarProps {
  displayName?: string;
  email?: string;
  viewerId?: string;
  avatar?: { revision: number } | null;
  size?: 'compact' | 'large';
  ariaLabel?: string;
}

/** Displays account-scoped private bytes and fails closed to deterministic identity text. */
export const Avatar = ({
  displayName = '',
  email = '',
  viewerId = '',
  avatar = null,
  size = 'compact',
  ariaLabel
}: AvatarProps) => {
  const queryClient = useQueryClient();
  const revision = avatar?.revision ?? 0;
  const image = useQuery(privateAvatarQuery(viewerId, revision, Boolean(viewerId && avatar)));
  const [source, setSource] = useState('');
  const sourceRef = useRef('');
  const displayedViewerRef = useRef('');
  const previousIdentityRef = useRef({ viewerId, revision, hasAvatar: Boolean(avatar) });

  const clearSource = () => {
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current);
    sourceRef.current = '';
    displayedViewerRef.current = '';
    setSource('');
  };

  useEffect(() => {
    // Never retain even a momentary image when the account itself changes or loses its avatar.
    if (!viewerId || !avatar || (displayedViewerRef.current && displayedViewerRef.current !== viewerId)) {
      clearSource();
    }
  }, [avatar, viewerId]);

  useEffect(() => {
    const previous = previousIdentityRef.current;
    if (previous.viewerId && previous.viewerId !== viewerId) {
      queryClient.removeQueries({ queryKey: ['account', previous.viewerId, 'avatar'] });
    } else if (previous.viewerId && previous.hasAvatar && !avatar) {
      queryClient.removeQueries({ queryKey: ['account', previous.viewerId, 'avatar'] });
    } else if (previous.viewerId && previous.hasAvatar && previous.revision !== revision) {
      queryClient.removeQueries({
        exact: true,
        queryKey: privateAvatarQueryKey(previous.viewerId, previous.revision)
      });
    }
    previousIdentityRef.current = { viewerId, revision, hasAvatar: Boolean(avatar) };
  }, [avatar, queryClient, revision, viewerId]);

  useEffect(() => {
    if (!image.data) return;
    const nextSource = URL.createObjectURL(image.data);
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current);
    sourceRef.current = nextSource;
    displayedViewerRef.current = viewerId;
    setSource(nextSource);
  }, [image.data, revision, viewerId]);

  useEffect(() => {
    // A failed authoritative revision must fall back rather than keep stale bytes indefinitely.
    if (image.isError) clearSource();
  }, [image.isError, revision, viewerId]);

  useEffect(() => () => {
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current);
  }, []);

  const initials = avatarInitials(displayName, email);
  const visibleSource = avatar && displayedViewerRef.current === viewerId ? source : '';
  return (
    <span
      aria-hidden={ariaLabel ? undefined : 'true'}
      aria-label={ariaLabel}
      className={`${styles.avatar} ${size === 'large' ? styles.large : ''}`}
      role={ariaLabel ? 'img' : undefined}
    >
      {visibleSource ? (
        <img
          alt=""
          className={styles.image}
          onError={clearSource}
          src={visibleSource}
        />
      ) : (initials || <Icon name="account" />)}
    </span>
  );
};
