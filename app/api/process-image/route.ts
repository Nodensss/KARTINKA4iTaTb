import OpenAI from "openai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const openAiModel = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const googleVisionEndpoint = "https://vision.googleapis.com/v1/images:annotate";

type OCRProvider = "google" | "openai";
type DescriptionProvider = "google" | "openai" | "none";

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
  if (value === "openai" || value === "none") {
    return value;
  }
  return "google";
}

type GoogleVisionResponse = {
  responses?: Array<{
    error?: { message?: string };
    fullTextAnnotation?: { text?: string };
    textAnnotations?: Array<{ description?: string }>;
    labelAnnotations?: Array<{ description?: string; score?: number }>;
    localizedObjectAnnotations?: Array<{ name?: string; score?: number }>;
  }>;
};

function uniqueTopTerms(values: Array<{ term: string; score: number }>) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of values) {
    const normalized = item.term.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(item.term.trim());
  }

  return result;
}

function buildGoogleDescription(params: {
  labels?: Array<{ description?: string; score?: number }>;
  objects?: Array<{ name?: string; score?: number }>;
  text: string;
}) {
  const labels = uniqueTopTerms(
    (params.labels ?? [])
      .filter(
        (item): item is { description: string; score?: number } =>
          typeof item.description === "string" &&
          item.description.trim().length > 0
      )
      .map((item) => ({
        term: item.description,
        score: item.score ?? 0
      }))
      .filter((item) => item.score >= 0.55)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
  );

  const objects = uniqueTopTerms(
    (params.objects ?? [])
      .filter(
        (item): item is { name: string; score?: number } =>
          typeof item.name === "string" && item.name.trim().length > 0
      )
      .map((item) => ({
        term: item.name,
        score: item.score ?? 0
      }))
      .filter((item) => item.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
  );

  if (labels.length === 0 && objects.length === 0) {
    return params.text
      ? "Скриншот с текстовым содержимым."
      : "";
  }

  const parts: string[] = [];
  if (labels.length > 0) {
    parts.push(`Похоже на: ${labels.join(", ")}.`);
  }
  if (objects.length > 0) {
    parts.push(`Объекты: ${objects.join(", ")}.`);
  }
  if (params.text) {
    parts.push("На изображении также есть текст.");
  }

  return parts.join(" ");
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

async function extractWithGoogleVision(params: { base64: string }) {
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
            features: [
              { type: "DOCUMENT_TEXT_DETECTION" },
              { type: "LABEL_DETECTION", maxResults: 8 },
              { type: "OBJECT_LOCALIZATION", maxResults: 8 }
            ],
            imageContext: {
              languageHints: ["ru", "en"]
            }
          }
        ]
      })
    }
  );

  const payload = (await response.json()) as GoogleVisionResponse;

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

  const normalizedText = typeof text === "string" ? text.trim() : "";
  const description = buildGoogleDescription({
    labels: result?.labelAnnotations,
    objects: result?.localizedObjectAnnotations,
    text: normalizedText
  });

  return { text: normalizedText, description };
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
      if (descriptionProvider === "openai") {
        description = openAiResult.description;
      } else if (descriptionProvider === "google") {
        const googleResult = await extractWithGoogleVision({ base64 });
        description = googleResult.description;
      }
    } else {
      const googleResult = await extractWithGoogleVision({ base64 });
      text = googleResult.text;
      if (descriptionProvider === "google") {
        description = googleResult.description;
      } else if (descriptionProvider === "openai") {
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
