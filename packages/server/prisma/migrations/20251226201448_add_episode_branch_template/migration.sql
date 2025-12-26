-- Add Episode Branch Pipeline Template
-- Used for individual episode processing in TV show branches
-- Flow: Download → Encode → Deliver (Search already done by parent)

INSERT INTO "PipelineTemplate" (
  "id",
  "name",
  "description",
  "mediaType",
  "isDefault",
  "isPublic",
  "steps",
  "layout",
  "createdAt",
  "updatedAt"
) VALUES (
  'episode-branch-pipeline',
  'Episode Branch Pipeline',
  'Pipeline for individual TV episode processing: Download → Encode → Deliver',
  'TV',
  false,
  false,
  '[{"type":"DOWNLOAD","name":"Download Episode","config":{"maxDownloadHours":24,"pollInterval":10000},"required":true,"retryable":true,"continueOnError":false,"children":[{"type":"ENCODE","name":"Encode Episode","config":{"videoEncoder":"libsvtav1","crf":28,"maxResolution":"1080p","hwAccel":"NONE","preset":"medium","audioEncoder":"copy","subtitlesMode":"COPY","container":"MKV","pollInterval":5000,"timeout":43200000},"required":true,"retryable":true,"continueOnError":false,"children":[{"type":"DELIVER","name":"Deliver Episode","config":{"verifyDelivery":true},"required":true,"retryable":true,"continueOnError":false}]}]}]'::jsonb,
  '{"nodes":[{"id":"start","type":"step","position":{"x":250,"y":50},"data":{"label":"Episode Branch Start","type":"START","config":{},"required":true,"retryable":false,"continueOnError":false}},{"id":"step-0","type":"step","position":{"x":250,"y":150},"data":{"label":"Download Episode","type":"DOWNLOAD","config":{"maxDownloadHours":24,"pollInterval":10000},"required":true,"retryable":true,"continueOnError":false}},{"id":"step-1","type":"step","position":{"x":250,"y":250},"data":{"label":"Encode Episode","type":"ENCODE","config":{"crf":28,"maxResolution":"1080p","preset":"medium","pollInterval":5000,"timeout":43200000},"required":true,"retryable":true,"continueOnError":false}},{"id":"step-2","type":"step","position":{"x":250,"y":350},"data":{"label":"Deliver Episode","type":"DELIVER","config":{"verifyDelivery":true},"required":true,"retryable":true,"continueOnError":false}}],"edges":[{"id":"e-start-0","source":"start","target":"step-0","type":"default"},{"id":"e-0-1","source":"step-0","target":"step-1","type":"default"},{"id":"e-1-2","source":"step-1","target":"step-2","type":"default"}],"viewport":{"x":0,"y":0,"zoom":0.75}}'::jsonb,
  NOW(),
  NOW()
) ON CONFLICT ("id") DO NOTHING;
