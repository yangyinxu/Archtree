import { Request, Response } from 'express';
import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse
} from '@simplewebauthn/server';
import type {
    AuthenticationResponseJSON,
    RegistrationResponseJSON
} from '@simplewebauthn/server';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { Passkey, PasskeyChallenge } from '../models/passkey';
import User from '../models/user';
import { createSession } from '../services/authSessionService';
import { recordAuthFunnelEvent, recordSecurityEvent } from '../services/securityAuditService';
import { normalizeUserRole } from '../services/authRoleService';

const configuration = () => {
    const rpID = String(process.env.WEBAUTHN_RP_ID ?? '').trim();
    const origin = String(process.env.WEBAUTHN_ORIGIN ?? '').trim();
    if (!rpID || !origin.startsWith('https://')) {
        const error = new Error('Passkeys are not configured for this deployment.') as Error & {
            statusCode?: number;
        };
        error.statusCode = 503;
        throw error;
    }
    return { rpID, origin, rpName: process.env.WEBAUTHN_RP_NAME ?? 'Finitude' };
};

/** Starts authenticated passkey enrollment and stores its one-time challenge. */
export const registrationOptions = async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const user = await User.findById(auth.userId);
    const existing = await Passkey.listForUser(auth.userId);
    const config = configuration();
    const options = await generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpID,
        userName: user?.email ?? auth.email,
        userDisplayName: user?.displayName || user?.email || auth.email,
        userID: new TextEncoder().encode(auth.userId),
        attestationType: 'none',
        excludeCredentials: existing.map(passkey => ({
            id: passkey.credentialId,
            transports: passkey.transports as any
        })),
        authenticatorSelection: {
            authenticatorAttachment: 'platform',
            residentKey: 'required',
            userVerification: 'required'
        }
    });
    const flowId = await PasskeyChallenge.issue('register', options.challenge, auth.userId);
    return res.status(200).json({ flowId, options });
};

/** Verifies enrollment before persisting public credential material. */
export const verifyRegistration = async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const flow = await PasskeyChallenge.consume(String(req.body.flowId ?? ''), 'register');
    if (!flow || flow.userId !== auth.userId) {
        return res.status(400).json({ message: 'The passkey request expired. Please try again.' });
    }
    const config = configuration();
    const verification = await verifyRegistrationResponse({
        response: req.body.credential as RegistrationResponseJSON,
        expectedChallenge: flow.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpID,
        requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ message: 'Passkey verification failed.' });
    }
    const { credential, credentialDeviceType, credentialBackedUp } =
        verification.registrationInfo;
    await Passkey.create({
        credentialId: credential.id,
        userId: auth.userId,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: (credential.transports ?? []) as string[],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp
    });
    recordSecurityEvent('passkey_registered', { userId: auth.userId });
    recordAuthFunnelEvent('link', 'passkey', 'succeeded');
    return res.status(204).send();
};

/** Starts discoverable-credential authentication without asking for an email. */
export const authenticationOptions = async (_req: Request, res: Response) => {
    const config = configuration();
    const options = await generateAuthenticationOptions({
        rpID: config.rpID,
        userVerification: 'required'
    });
    const flowId = await PasskeyChallenge.issue('authenticate', options.challenge);
    return res.status(200).json({ flowId, options });
};

/** Verifies an assertion, advances its counter, and creates a rotating app session. */
export const verifyAuthentication = async (req: Request, res: Response) => {
    const response = req.body.credential as AuthenticationResponseJSON;
    const flow = await PasskeyChallenge.consume(
        String(req.body.flowId ?? ''),
        'authenticate'
    );
    const passkey = await Passkey.findByCredentialId(String(response?.id ?? ''));
    if (!flow || !passkey) {
        return res.status(401).json({ message: 'Passkey authentication failed.' });
    }
    const config = configuration();
    const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: flow.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpID,
        requireUserVerification: true,
        credential: {
            id: passkey.credentialId,
            publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
            counter: passkey.counter,
            transports: passkey.transports as any
        }
    });
    if (!verification.verified) {
        return res.status(401).json({ message: 'Passkey authentication failed.' });
    }
    const user = await User.findById(passkey.userId);
    if (!user) {
        return res.status(401).json({ message: 'Passkey authentication failed.' });
    }
    await Passkey.updateCounter(passkey.credentialId, verification.authenticationInfo.newCounter);
    const tokens = await createSession(user as any, req);
    recordSecurityEvent('passkey_login_succeeded', {
        userId: user._id.toString(),
        sessionId: tokens.sessionId
    });
    recordAuthFunnelEvent('login', 'passkey', 'succeeded');
    return res.status(200).json({
        ...tokens,
        userId: user._id.toString(),
        email: user.email,
        role: normalizeUserRole(user.role)
    });
};
