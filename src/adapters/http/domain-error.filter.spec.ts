import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DomainViolation } from '../../domain/errors';
import { DomainErrorFilter } from './domain-error.filter';

/**
 * How a domain refusal reaches a caller.
 *
 * Exercised through a real request rather than a faked context, as the guard's
 * spec is: the filter's whole job is the response, and a test that inspected a
 * mock would be asserting the shape of the mock.
 */
@Controller('refusals')
class RefusingController {
  @Get('unanswerable')
  unanswerable(): never {
    throw new DomainViolation({ kind: 'unanswerable' });
  }

  @Get('validation')
  validation(): never {
    throw new DomainViolation({
      kind: 'validation',
      field: 'question',
      detail: 'is wrong in some stated way',
    });
  }
}

describe('a domain refusal, as a caller receives it', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const built = await Test.createTestingModule({
      controllers: [RefusingController],
    }).compile();

    app = built.createNestApplication();
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * The request was well formed, authorised, and about a tenant that exists.
   * It simply cannot be processed — which is neither the caller's mistake nor
   * the service being unavailable, and is why it is neither `400` nor `503`.
   */
  it('answers a question nobody can answer as unprocessable', async () => {
    const refused = await request(app.getHttpServer() as App)
      .get('/refusals/unanswerable')
      .expect(422);

    expect(refused.body).toEqual({
      statusCode: 422,
      message: 'the question could not be answered',
    });
  });

  /**
   * No field, and the absence is the point: there is no part of the question to
   * point at, and pointing at one would blame the caller for the platform's own
   * limit.
   */
  it('points at no part of the question, because none is at fault', async () => {
    const refused = await request(app.getHttpServer() as App)
      .get('/refusals/unanswerable')
      .expect(422);

    expect(refused.body).not.toHaveProperty('field');
  });

  /**
   * It names nothing: not a measure, not a grouping, not a tenant, and nothing
   * an engine wrote. A refusal nobody can act on has nothing to say beyond
   * that it happened.
   */
  it('names nothing at all', async () => {
    const refused = await request(app.getHttpServer() as App)
      .get('/refusals/unanswerable')
      .expect(422);

    const message = (refused.body as { message: string }).message;
    expect(message).not.toMatch(/[a-z]+(?:_[a-z]+)+/);
    expect(message).not.toMatch(/[a-z_]+\.[a-z_]+/);
  });

  it('still answers a rejected question as before', async () => {
    const refused = await request(app.getHttpServer() as App)
      .get('/refusals/validation')
      .expect(400);

    expect(refused.body).toEqual({
      statusCode: 400,
      message: 'question is wrong in some stated way',
      field: 'question',
    });
  });
});
