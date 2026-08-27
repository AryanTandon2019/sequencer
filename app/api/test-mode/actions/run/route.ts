import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { executeMockTestModeAction } from "@/src/application/mock-action-executor";
import {
  assertMockExecutorEnabled,
  runDueTestModeActions,
} from "@/src/application/test-mode-action-runner";
import { assertNonProductionDatabase } from "@/src/application/test-mode-runtime";
import { getPostgresTestModeStore } from "@/src/infrastructure/postgres-test-mode-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secureTokenEqual(received: string, expected: string): boolean {
  const receivedDigest = createHash("sha256").update(received).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

function authorize(request: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (secret === undefined || secret.length === 0) {
    return Response.json(
      { accepted: false, error: "Test Mode action runner is not configured" },
      { status: 503 },
    );
  }
  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  const token = authorization.startsWith(prefix) ? authorization.slice(prefix.length) : "";
  if (!secureTokenEqual(token, secret)) {
    return Response.json(
      { accepted: false, error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return null;
}

async function handle(request: Request) {
  const rejection = authorize(request);
  if (rejection !== null) return rejection;

  try {
    assertMockExecutorEnabled();
  } catch {
    return Response.json(
      { accepted: false, error: "Mock Test Mode execution is disabled" },
      { status: 503 },
    );
  }

  try {
    assertNonProductionDatabase();
  } catch {
    return Response.json(
      { accepted: false, error: "Non-production Test Mode database is not confirmed" },
      { status: 503 },
    );
  }

  let store;
  try {
    store = getPostgresTestModeStore();
  } catch {
    return Response.json(
      { accepted: false, error: "Durable Test Mode queue is not configured" },
      { status: 503 },
    );
  }

  const workerId = `vercel:${process.env.VERCEL_REGION ?? "local"}:${randomUUID()}`;
  try {
    const report = await runDueTestModeActions({
      store,
      execute: executeMockTestModeAction,
      workerId,
      maxActions: 10,
    });
    return Response.json(
      { accepted: true, mode: "test", executor: "mock", ...report },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { accepted: false, error: "Test Mode action runner failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
