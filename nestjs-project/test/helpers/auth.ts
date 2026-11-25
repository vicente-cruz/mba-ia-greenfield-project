import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { MailService } from '../../src/mail/mail.service';
import { authTokensBody } from './response-bodies';

/**
 * Registers, confirms and logs in a user through the auth endpoints, as `auth.e2e-spec.ts` does,
 * and returns the access token. The confirmation e-mail is captured instead of being sent.
 */
export async function registerConfirmedUser(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  let confirmationToken = '';
  const sendSpy = jest
    .spyOn(app.get(MailService), 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });
  try {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
  } finally {
    sendSpy.mockRestore();
  }
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  return authTokensBody(login).access_token;
}
