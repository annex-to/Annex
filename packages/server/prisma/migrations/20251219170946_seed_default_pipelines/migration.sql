-- Seed default pipeline templates for Movie and TV requests

-- Default Movie Pipeline
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
  'default-movie-pipeline',
  'Standard Movie Pipeline',
  'Default workflow for movie requests: Search → Download → Encode → Deliver',
  'MOVIE',
  true,
  true,
  '[{"type":"SEARCH","name":"Find Release","config":{"minSeeds":5,"timeoutSeconds":300},"required":true,"retryable":true,"continueOnError":false,"children":[{"type":"DOWNLOAD","name":"Download Source","config":{"maxDownloadHours":24,"pollInterval":10000},"required":true,"retryable":true,"continueOnError":false,"children":[{"type":"ENCODE","name":"Encode to AV1","config":{"crf":28,"maxResolution":"1080p","preset":"medium","pollInterval":5000,"timeout":43200000},"required":true,"retryable":true,"continueOnError":false,"children":[{"type":"DELIVER","name":"Deliver to Servers","config":{"verifyDelivery":true},"required":true,"retryable":true,"continueOnError":false}]}]}]}]'::jsonb,
  '{"nodes":[{"id":"start","type":"step","position":{"x":250,"y":50},"data":{"label":"Request Submitted","type":"START","config":{},"required":true,"retryable":false,"continueOnError":false}},{"id":"step-0","type":"step","position":{"x":250,"y":150},"data":{"label":"Find Release","type":"SEARCH","config":{"minSeeds":5,"timeoutSeconds":300},"required":true,"retryable":true,"continueOnError":false}},{"id":"step-1","type":"step","position":{"x":250,"y":250},"data":{"label":"Download Source","type":"DOWNLOAD","config":{"maxDownloadHours":24,"pollInterval":10000},"required":true,"retryable":true,"continueOnError":false}},{"id":"step-2","type":"step","position":{"x":250,"y":350},"data":{"label":"Encode to AV1","type":"ENCODE","config":{"crf":28,"maxResolution":"1080p","preset":"medium","pollInterval":5000,"timeout":43200000},"required":true,"retryable":true,"continueOnError":false}},{"id":"step-3","type":"step","position":{"x":250,"y":450},"data":{"label":"Deliver to Servers","type":"DELIVER","config":{"verifyDelivery":true},"required":true,"retryable":true,"continueOnError":false}}],"edges":[{"id":"e-start-0","source":"start","target":"step-0","type":"default"},{"id":"e-0-1","source":"step-0","target":"step-1","type":"default"},{"id":"e-1-2","source":"step-1","target":"step-2","type":"default"},{"id":"e-2-3","source":"step-2","target":"step-3","type":"default"}],"viewport":{"x":0,"y":0,"zoom":0.75}}'::jsonb,
  NOW(),
  NOW()
) ON CONFLICT ("id") DO NOTHING;

-- Default TV Pipeline
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
  'default-tv-pipeline',
  'Standard TV Pipeline',
  'Default workflow for TV requests: Search → Download → Encode → Deliver',
  'TV',
  true,
  true,
  '[{"type":"SEARCH","name":"Find Release","config":{"minSeeds":3,"timeoutSeconds":300},"required":true,"retryable":true,"continueOnError":false,"children":[{"type":"DOWNLOAD","name":"Download Source","config":{"maxDownloadHours":24,"pollInterval":10000},"required":true,"retryable":true,"continueOnError":false,"children":[{"type":"ENCODE","name":"Encode to AV1","config":{"crf":28,"maxResolution":"1080p","preset":"medium","pollInterval":5000,"timeout":43200000},"required":true,"retryable":true,"continueOnError":false,"children":[{"type":"DELIVER","name":"Deliver to Servers","config":{"verifyDelivery":true},"required":true,"retryable":true,"continueOnError":false}]}]}]}]'::jsonb,
  '{"nodes":[{"id":"start","type":"step","position":{"x":250,"y":50},"data":{"label":"Request Submitted","type":"START","config":{},"required":true,"retryable":false,"continueOnError":false}},{"id":"step-0","type":"step","position":{"x":250,"y":150},"data":{"label":"Find Release","type":"SEARCH","config":{"minSeeds":3,"timeoutSeconds":300},"required":true,"retryable":true,"continueOnError":false}},{"id":"step-1","type":"step","position":{"x":250,"y":250},"data":{"label":"Download Source","type":"DOWNLOAD","config":{"maxDownloadHours":24,"pollInterval":10000},"required":true,"retryable":true,"continueOnError":false}},{"id":"step-2","type":"step","position":{"x":250,"y":350},"data":{"label":"Encode to AV1","type":"ENCODE","config":{"crf":28,"maxResolution":"1080p","preset":"medium","pollInterval":5000,"timeout":43200000},"required":true,"retryable":true,"continueOnError":false}},{"id":"step-3","type":"step","position":{"x":250,"y":450},"data":{"label":"Deliver to Servers","type":"DELIVER","config":{"verifyDelivery":true},"required":true,"retryable":true,"continueOnError":false}}],"edges":[{"id":"e-start-0","source":"start","target":"step-0","type":"default"},{"id":"e-0-1","source":"step-0","target":"step-1","type":"default"},{"id":"e-1-2","source":"step-1","target":"step-2","type":"default"},{"id":"e-2-3","source":"step-2","target":"step-3","type":"default"}],"viewport":{"x":0,"y":0,"zoom":0.75}}'::jsonb,
  NOW(),
  NOW()
) ON CONFLICT ("id") DO NOTHING;
