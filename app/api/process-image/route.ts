import OpenAI from "openai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const openAiModel = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const googleVisionEndpoint = "https://vision.googleapis.com/v1/images:annotate";

type OCRProvider = "google" | "openai";
type DescriptionProvider = "openai" | "none";

function parseJson(content: string | null | undefined) {
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY не задан. Добавьте его в переменные окружения."
    );
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function normalizeOCRProvider(value: FormDataEntryValue | null): OCRProvider {
  return value === "openai" ? "openai" : "google";
}

function normalizeDescriptionProvider(
  value: FormDataEntryValue | null
): DescriptionProvider {
  return value === "none" ? "none" : "openai";
}

async function extractWithOpenAI(params: {
  base64: string;
  mimeType: string;
}) {
  const client = getOpenAIClient();

  const completion = await client.chat.completions.create({
    model: openAiModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You extract text from screenshots accurately. Return valid JSON only."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Извлеки весь видимый текст с изображения максимально точно. " +
              "Дополнительно дай короткое описание изображения в поле description, " +
              "если описание вообще уместно. " +
              "Верни JSON строго в формате: {\"text\":\"...\",\"description\":\"...\"}. " +
              "Если текста нет, поставь text пустой строкой."
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${params.mimeType};base64,${params.base64}`
            }
          }
        ]
      }
    ]
  });

  const raw = completion.choices[0]?.message?.content;
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("OpenAI вернул неожиданный формат для OCR.");
  }

  return {
    text: typeof parsed.text === "string" ? parsed.text.trim() : "",
    description:
      typeof parsed.description === "string"
        ? parsed.description.trim()
        : ""
  };
}

async function describeWithOpenAI(params: { base64: string; mimeType: string }) {
  const client = getOpenAIClient();

  const completion = await client.chat.completions.create({
    model: openAiModel,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You provide concise and precise image descriptions. Return valid JSON only."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Сделай короткое описание изображения. " +
              "Верни JSON строго в формате: {\"description\":\"...\"}. " +
              "Если описание неуместно, верни пустую строку."
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${params.mimeType};base64,${params.base64}`
            }
          }
        ]
      }
    ]
  });

  const raw = completion.choices[0]?.message?.content;
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("OpenAI вернул неожиданный формат для description.");
  }

  return typeof parsed.description === "string"
    ? parsed.description.trim()
    : "";
}

async function extractTextWithGoogle(params: { base64: string }) {
  if (!process.env.GOOGLE_VISION_API_KEY) {
    throw new Error(
      "GOOGLE_VISION_API_KEY не задан. Добавьте его в переменные окружения."
    );
  }

  const response = await fetch(
    `${googleVisionEndpoint}?key=${process.env.GOOGLE_VISION_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: params.base64 },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            imageContext: {
              languageHints: ["ru", "en"]
            }
          }
        ]
      })
    }
  );

  const payload = (await response.json()) as {
    responses?: Array<{
      error?: { message?: string };
      fullTextAnnotation?: { text?: string };
      textAnnotations?: Array<{ description?: string }>;
    }>;
  };

  if (!response.ok) {
    throw new Error(
      `Google Vision HTTP ${response.status}: ${JSON.stringify(payload)}`
    );
  }

  const result = payload.responses?.[0];
  if (result?.error?.message) {
    throw new Error(`Google Vision: ${result.error.message}`);
  }

  const text =
    result?.fullTextAnnotation?.text ??
    result?.textAnnotations?.[0]?.description ??
    "";

  return typeof text === "string" ? text.trim() : "";
}

export async function POST(req: Request) {
  const formData = await req.formData();
  const file = formData.get("image");
  const ocrProvider = normalizeOCRProvider(formData.get("ocrProvider"));
  const descriptionProvider = normalizeDescriptionProvider(
    formData.get("descriptionProvider")
  );

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Ожидался файл с ключом image." },
      { status: 400 }
    );
  }

  if (!file.type.startsWith("image/")) {
    return NextResponse.json(
      { error: "Поддерживаются только изображения." },
      { status: 400 }
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");

  try {
    let text = "";
    let description = "";

    if (ocrProvider === "openai") {
      const openAiResult = await extractWithOpenAI({
        base64,
        mimeType: file.type
      });
      text = openAiResult.text;
      description =
        descriptionProvider === "openai" ? openAiResult.description : "";
    } else {
      text = await extractTextWithGoogle({ base64 });
      if (descriptionProvider === "openai") {
        description = await describeWithOpenAI({
          base64,
          mimeType: file.type
        });
      }
    }

    return NextResponse.json({
      text,
      description,
      providers: {
        ocr: ocrProvider,
        description: descriptionProvider
      }
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Неизвестная ошибка API";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
