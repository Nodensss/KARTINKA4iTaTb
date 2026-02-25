# Screenshot Text Extractor (Vercel)

Приложение на Next.js, которое:
- принимает пачку изображений (скриншотов),
- извлекает текст (OCR),
- добавляет краткое описание изображения,
- показывает результаты в интерфейсе с кнопками копирования,
- позволяет выбрать провайдер OCR и провайдер описания.

## Стек
- Next.js (App Router, TypeScript)
- Google Cloud Vision API (OCR)
- OpenAI API (описание и/или OCR)

## Локальный запуск
1. Установите зависимости:
   ```bash
   npm install
   ```
2. Скопируйте `.env.example` в `.env` и укажите ключ:
   ```bash
   GOOGLE_VISION_API_KEY=...
   OPENAI_API_KEY=...
   OPENAI_MODEL=gpt-4.1-mini
   ```
3. Запустите:
   ```bash
   npm run dev
   ```
4. Откройте `http://localhost:3000`.

## Deploy на Vercel
1. Импортируйте репозиторий в Vercel.
2. Добавьте Environment Variables:
   - `GOOGLE_VISION_API_KEY`
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL` (опционально)
3. Нажмите Deploy.

## Режимы провайдеров
- По умолчанию: `OCR = Google Vision`, `Описание = OpenAI`.
- Можно переключить `OCR = OpenAI`.
- Можно отключить описание (`Описание = Не извлекать`).

## Как это работает
- Клиент загружает выбранные файлы и обрабатывает их в очереди.
- Каждый файл отправляется в `/api/process-image` отдельным запросом.
- API выбирает провайдер по параметрам формы и возвращает JSON:
  - `text`
  - `description`

Это снижает риск упереться в лимит размера одного запроса на сервере.
