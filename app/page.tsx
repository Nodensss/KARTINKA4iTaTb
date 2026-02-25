"use client";

import { useMemo, useState } from "react";

type ItemStatus = "queued" | "processing" | "done" | "error";
type OCRProvider = "google" | "openai";
type DescriptionProvider = "google" | "openai" | "none";

type ResultItem = {
  id: string;
  file: File;
  status: ItemStatus;
  text: string;
  description: string;
  error: string;
};

type ApiResult = {
  text?: string;
  description?: string;
  error?: string;
  providers?: {
    ocr: OCRProvider;
    description: DescriptionProvider;
  };
};

const CONCURRENCY = 3;

function normalizeFiles(input: FileList | null): ResultItem[] {
  if (!input) {
    return [];
  }

  return Array.from(input).map((file, idx) => ({
    id: `${file.name}-${file.lastModified}-${idx}`,
    file,
    status: "queued",
    text: "",
    description: "",
    error: ""
  }));
}

async function processOneImage(
  file: File,
  providers: {
    ocrProvider: OCRProvider;
    descriptionProvider: DescriptionProvider;
  }
): Promise<ApiResult> {
  const formData = new FormData();
  formData.append("image", file);
  formData.append("ocrProvider", providers.ocrProvider);
  formData.append("descriptionProvider", providers.descriptionProvider);

  const response = await fetch("/api/process-image", {
    method: "POST",
    body: formData
  });

  const json = (await response.json()) as ApiResult;
  if (!response.ok) {
    return { error: json.error ?? `Ошибка ${response.status}` };
  }
  return json;
}

export default function HomePage() {
  const [items, setItems] = useState<ResultItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const [ocrProvider, setOcrProvider] = useState<OCRProvider>("google");
  const [descriptionProvider, setDescriptionProvider] =
    useState<DescriptionProvider>("google");

  const stats = useMemo(() => {
    const total = items.length;
    const done = items.filter((item) => item.status === "done").length;
    const processing = items.filter(
      (item) => item.status === "processing"
    ).length;
    const errors = items.filter((item) => item.status === "error").length;
    return { total, done, processing, errors };
  }, [items]);

  const setStatus = (
    id: string,
    patch: Partial<Pick<ResultItem, "status" | "text" | "description" | "error">>
  ) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  };

  const handleSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    setCopyMessage("");
    setItems(normalizeFiles(event.target.files));
  };

  const run = async () => {
    if (items.length === 0 || isRunning) {
      return;
    }

    setIsRunning(true);
    const queue = [...items];
    const selectedProviders = { ocrProvider, descriptionProvider };

    const worker = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) {
          return;
        }

        setStatus(next.id, {
          status: "processing",
          error: "",
          text: "",
          description: ""
        });

        const result = await processOneImage(next.file, selectedProviders);

        if (result.error) {
          setStatus(next.id, { status: "error", error: result.error });
        } else {
          setStatus(next.id, {
            status: "done",
            text: result.text ?? "",
            description: result.description ?? ""
          });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () =>
        worker()
      )
    );
    setIsRunning(false);
  };

  const copyText = async (text: string, label: string) => {
    if (!text.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage(`Скопировано: ${label}`);
      window.setTimeout(() => setCopyMessage(""), 1500);
    } catch {
      setCopyMessage("Не удалось скопировать");
      window.setTimeout(() => setCopyMessage(""), 1500);
    }
  };

  const copyAll = async () => {
    const chunks = items
      .filter((item) => item.status === "done")
      .map((item) => {
        return [
          `Файл: ${item.file.name}`,
          `Описание: ${item.description || "-"}`,
          "Текст:",
          item.text || "-"
        ].join("\n");
      });

    if (chunks.length === 0) {
      return;
    }
    await copyText(chunks.join("\n\n---\n\n"), "все результаты");
  };

  return (
    <main className="page">
      <section className="hero">
        <span className="kicker">Vercel-ready OCR</span>
        <h1>Скриншоты {"->"} текст + описание</h1>
        <p>
          Загрузите до нескольких десятков скриншотов, запустите
          обработку и копируйте текст или описание по одному файлу
          либо сразу весь результат.
        </p>
      </section>

      <section className="uploader">
        <div className="actions">
          <label className="btn">
            Выбрать изображения
            <input
              hidden
              type="file"
              accept="image/*"
              multiple
              onChange={handleSelect}
            />
          </label>
          <button
            className="btn primary"
            onClick={run}
            disabled={items.length === 0 || isRunning}
          >
            {isRunning ? "Обработка..." : "Запустить обработку"}
          </button>
          <button
            className="btn"
            onClick={copyAll}
            disabled={stats.done === 0}
          >
            Скопировать все
          </button>
        </div>

        <div className="config">
          <label className="field">
            <span className="label">OCR провайдер</span>
            <select
              className="select"
              value={ocrProvider}
              disabled={isRunning}
              onChange={(event) =>
                setOcrProvider(event.target.value as OCRProvider)
              }
            >
              <option value="google">Google Vision (лучше OCR)</option>
              <option value="openai">OpenAI Vision</option>
            </select>
          </label>

          <label className="field">
            <span className="label">Описание</span>
            <select
              className="select"
              value={descriptionProvider}
              disabled={isRunning}
              onChange={(event) =>
                setDescriptionProvider(
                  event.target.value as DescriptionProvider
                )
              }
            >
              <option value="google">Google Vision (без OpenAI)</option>
              <option value="openai">OpenAI</option>
              <option value="none">Не извлекать</option>
            </select>
          </label>
        </div>

        <div className="summary">
          Режим: OCR{" "}
          {ocrProvider === "google" ? "Google Vision" : "OpenAI Vision"} |{" "}
          Описание{" "}
          {descriptionProvider === "google"
            ? "Google Vision"
            : descriptionProvider === "openai"
              ? "OpenAI"
              : "выключено"}
          {" | "}
          Всего: {stats.total} | Готово: {stats.done} | В работе:{" "}
          {stats.processing} | Ошибки: {stats.errors}
          {copyMessage ? ` | ${copyMessage}` : ""}
        </div>
      </section>

      <section className="results">
        {items.map((item) => {
          return (
            <article key={item.id} className="card">
              <div className="card-header">
                <div className="card-title">{item.file.name}</div>
                <span className={`status ${item.status}`}>
                  {item.status}
                </span>
              </div>

              {item.status === "error" ? (
                <div className="error-box">{item.error}</div>
              ) : null}

              <div className="section">
                <span className="label">Описание</span>
                <div className="value">
                  {item.description || (item.status === "done" ? "-" : "")}
                </div>
              </div>

              <div className="section">
                <span className="label">Текст</span>
                <div className="value">
                  {item.text || (item.status === "done" ? "-" : "")}
                </div>
              </div>

              <div className="section row">
                <button
                  className="btn"
                  onClick={() =>
                    copyText(item.description, `описание ${item.file.name}`)
                  }
                  disabled={item.status !== "done" || !item.description}
                >
                  Скопировать описание
                </button>
                <button
                  className="btn"
                  onClick={() =>
                    copyText(item.text, `текст ${item.file.name}`)
                  }
                  disabled={item.status !== "done" || !item.text}
                >
                  Скопировать текст
                </button>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}
