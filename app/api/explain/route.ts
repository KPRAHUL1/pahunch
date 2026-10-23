import { NextResponse } from "next/server";
import { z } from "zod";

import { isSupportedLanguage, speakVerdict } from "@/lib/sarvam";

export const dynamic = "force-dynamic";

const Schema = z.object({
  text: z.string().min(1).max(4000),
  language: z.string().refine(isSupportedLanguage, "Unsupported language"),
  withAudio: z.boolean().default(false),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { text, language, withAudio } = parsed.data;
  const result = await speakVerdict(text, language, withAudio);
  return NextResponse.json(result);
}
