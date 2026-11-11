import type { FilingPacket, NajizStatus, NajizEvent } from './types';

/**
 * THE ONE PLACE THAT KNOWS NAJIZ'S WIRE FORMAT. It is deliberately empty.
 *
 * What is public (the Najiz Developers Portal guideline): products are grouped by service type (courts,
 * enforcement, authentication, …); each product page carries Swagger documents with request and response samples;
 * calls go through Apigee with an access token generated from the application's Consumer Key / Consumer Secret and
 * sent as a Bearer token over HTTPS 443; a service can only be called after it is linked to an approved
 * application, which needs a data-sharing agreement with the Ministry of Justice.
 *
 * What is NOT public: the courts services' endpoints, field names, court and claim-type codes, document rules,
 * and whether the services accept an idempotency key or push events. Inventing any of that would produce code that
 * looks finished and fails on first contact, so none of it is guessed here.
 *
 * To finish the integration: obtain access (docs/NAJIZ.md, "Onboarding"), read the Swagger of the courts services,
 * implement `NajizContract` below, and export it as NAJIZ_CONTRACT. `test/najiz-http.test.ts` shows the shape with a
 * fake contract, and every mechanism around it (token handling, timeouts, ambiguity rules) is already built and tested.
 */
export interface HttpRequest { method: 'GET' | 'POST'; path: string; json?: unknown; form?: FormData; headers?: Record<string, string> }

export interface NajizContract {
  submit: {
    build(packet: FilingPacket): HttpRequest;
    parse(status: number, body: unknown): { najizRef: string; status: NajizStatus; acceptedAt: string; courtCaseNumber?: string };
    /** Header Najiz reads for idempotency, if it supports one. Leave undefined if it does not (then retries are never automatic anyway). */
    idempotencyHeader?: string;
  };
  updates: {
    build(najizRef: string): HttpRequest;
    parse(status: number, body: unknown): { status: NajizStatus; courtCaseNumber?: string; events: NajizEvent[] };
  };
  /** Classifies an HTTP error status. `definitive` = Najiz processed the request and refused it. */
  classify?(status: number, body: unknown): 'REJECTED' | 'AUTH' | undefined;
}

export const NAJIZ_CONTRACT: NajizContract | null = null;
