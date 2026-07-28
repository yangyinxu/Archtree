import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { AuthActionPurpose } from '../models/authActionToken';

/** Fails before account mutation when the deployment cannot deliver auth mail. */
export const requireAuthEmailConfiguration = () => {
    const sender = String(process.env.AUTH_EMAIL_FROM ?? '').trim();
    if (!sender || !process.env.AWS_REGION) {
        const error = new Error('Authentication email delivery is not configured.') as Error & {
            statusCode?: number;
        };
        error.statusCode = 503;
        throw error;
    }
    return sender;
};

/** Sends authentication codes through SES without writing codes to application logs. */
export const sendAuthCode = async (
    recipient: string,
    purpose: AuthActionPurpose,
    code: string
) => {
    const sender = requireAuthEmailConfiguration();
    const verification = purpose === 'verifyEmail';
    const subject = verification ? 'Verify your Finitude email' : 'Reset your Finitude password';
    const action = verification ? 'verify your email' : 'reset your password';
    const client = new SESv2Client({ region: process.env.AWS_REGION });
    await client.send(new SendEmailCommand({
        FromEmailAddress: sender,
        Destination: { ToAddresses: [recipient] },
        Content: {
            Simple: {
                Subject: { Data: subject, Charset: 'UTF-8' },
                Body: {
                    Text: {
                        Data: `Use code ${code} to ${action}. This code expires soon. If you did not request it, you can ignore this email.`,
                        Charset: 'UTF-8'
                    }
                }
            }
        }
    }));
};
