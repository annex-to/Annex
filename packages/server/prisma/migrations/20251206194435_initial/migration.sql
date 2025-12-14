-- CreateEnum
CREATE TYPE "Protocol" AS ENUM ('SFTP', 'RSYNC', 'SMB');

-- CreateEnum
CREATE TYPE "Resolution" AS ENUM ('4K', '2K', '1080p', '720p', '480p');

-- CreateEnum
CREATE TYPE "Codec" AS ENUM ('AV1', 'HEVC', 'H264');

-- CreateEnum
CREATE TYPE "MediaServerType" AS ENUM ('PLEX', 'EMBY', 'NONE');

-- CreateEnum
CREATE TYPE "IndexerType" AS ENUM ('TORZNAB', 'NEWZNAB', 'RSS', 'TORRENTLEECH');

-- CreateEnum
CREATE TYPE "HwAccel" AS ENUM ('NONE', 'QSV', 'NVENC', 'VAAPI', 'AMF', 'VIDEOTOOLBOX');

-- CreateEnum
CREATE TYPE "SubtitlesMode" AS ENUM ('COPY', 'COPY_TEXT', 'EXTRACT', 'NONE');

-- CreateEnum
CREATE TYPE "Container" AS ENUM ('MKV', 'MP4', 'WEBM');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('MOVIE', 'TV');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'SEARCHING', 'DOWNLOADING', 'ENCODING', 'DELIVERING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "EncodingStatus" AS ENUM ('QUEUED', 'ENCODING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('INFO', 'WARNING', 'ERROR', 'SUCCESS');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "username" TEXT NOT NULL,
    "avatar" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlexAccount" (
    "id" TEXT NOT NULL,
    "plexId" TEXT NOT NULL,
    "plexUsername" TEXT NOT NULL,
    "plexEmail" TEXT,
    "plexThumb" TEXT,
    "plexToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "PlexAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmbyAccount" (
    "id" TEXT NOT NULL,
    "embyId" TEXT NOT NULL,
    "embyUsername" TEXT NOT NULL,
    "embyServerId" TEXT,
    "embyToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "EmbyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageServer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "protocol" "Protocol" NOT NULL,
    "username" TEXT NOT NULL,
    "encryptedPassword" TEXT,
    "encryptedPrivateKey" TEXT,
    "pathMovies" TEXT NOT NULL,
    "pathTv" TEXT NOT NULL,
    "maxResolution" "Resolution" NOT NULL,
    "maxFileSize" BIGINT,
    "preferredCodec" "Codec" NOT NULL,
    "maxBitrate" INTEGER,
    "mediaServerType" "MediaServerType" NOT NULL DEFAULT 'NONE',
    "mediaServerUrl" TEXT,
    "mediaServerApiKey" TEXT,
    "mediaServerLibraryMovies" TEXT[],
    "mediaServerLibraryTv" TEXT[],
    "librarySyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "librarySyncInterval" INTEGER NOT NULL DEFAULT 5,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "encodingProfileId" TEXT,

    CONSTRAINT "StorageServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Indexer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "IndexerType" NOT NULL,
    "url" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "categoriesMovies" INTEGER[],
    "categoriesTv" INTEGER[],
    "priority" INTEGER NOT NULL DEFAULT 50,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Indexer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EncodingProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "videoEncoder" TEXT NOT NULL DEFAULT 'libsvtav1',
    "videoQuality" INTEGER NOT NULL DEFAULT 25,
    "videoMaxResolution" "Resolution" NOT NULL DEFAULT '1080p',
    "videoMaxBitrate" INTEGER,
    "hwAccel" "HwAccel" NOT NULL DEFAULT 'NONE',
    "hwDevice" TEXT,
    "videoFlags" JSONB NOT NULL DEFAULT '{}',
    "audioEncoder" TEXT NOT NULL DEFAULT 'copy',
    "audioFlags" JSONB NOT NULL DEFAULT '{}',
    "subtitlesMode" "SubtitlesMode" NOT NULL DEFAULT 'COPY',
    "container" "Container" NOT NULL DEFAULT 'MKV',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EncodingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaRequest" (
    "id" TEXT NOT NULL,
    "type" "MediaType" NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "requestedSeasons" INTEGER[],
    "requestedEpisodes" JSONB,
    "targets" JSONB NOT NULL DEFAULT '[]',
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentStep" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "userId" TEXT,

    CONSTRAINT "MediaRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EncodingJob" (
    "id" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "outputFile" TEXT,
    "status" "EncodingStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,

    CONSTRAINT "EncodingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "mdblistJobId" TEXT,
    "mdblistMovieExportUrl" TEXT,
    "mdblistTvExportUrl" TEXT,
    "mdblistLastMovieId" INTEGER,
    "mdblistLastTvId" INTEGER,
    "mdblistMovieTotal" INTEGER,
    "mdblistTvTotal" INTEGER,
    "mdblistStartedAt" TIMESTAMP(3),
    "tmdbJobId" TEXT,
    "tmdbLastMovieId" INTEGER,
    "tmdbLastTvId" INTEGER,
    "tmdbMovieTotal" INTEGER,
    "tmdbTvTotal" INTEGER,
    "tmdbStartedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "progressTotal" INTEGER,
    "progressCurrent" INTEGER,
    "error" TEXT,
    "result" JSONB,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestId" TEXT,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryItem" (
    "id" TEXT NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "type" "MediaType" NOT NULL,
    "quality" TEXT,
    "addedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "serverId" TEXT NOT NULL,

    CONSTRAINT "LibraryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaItem" (
    "id" TEXT NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "imdbId" TEXT,
    "traktId" INTEGER,
    "tvdbId" INTEGER,
    "malId" INTEGER,
    "type" "MediaType" NOT NULL,
    "title" TEXT NOT NULL,
    "originalTitle" TEXT,
    "year" INTEGER,
    "releaseDate" TEXT,
    "overview" TEXT,
    "tagline" TEXT,
    "posterPath" TEXT,
    "backdropPath" TEXT,
    "genres" TEXT[],
    "keywords" TEXT[],
    "certification" TEXT,
    "runtime" INTEGER,
    "status" TEXT,
    "language" TEXT,
    "country" TEXT,
    "spokenLanguages" TEXT[],
    "productionCountries" TEXT[],
    "numberOfSeasons" INTEGER,
    "numberOfEpisodes" INTEGER,
    "networks" JSONB,
    "createdBy" TEXT[],
    "director" TEXT,
    "budget" BIGINT,
    "revenue" BIGINT,
    "cast" JSONB,
    "crew" JSONB,
    "videos" JSONB,
    "productionCompanies" JSONB,
    "watchProviders" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tmdbUpdatedAt" TIMESTAMP(3),
    "mdblistUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "MediaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "overview" TEXT,
    "posterPath" TEXT,
    "airDate" TEXT,
    "episodeCount" INTEGER NOT NULL DEFAULT 0,
    "mediaItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Episode" (
    "id" TEXT NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "overview" TEXT,
    "stillPath" TEXT,
    "airDate" TEXT,
    "runtime" INTEGER,
    "seasonId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Episode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaRatings" (
    "id" TEXT NOT NULL,
    "tmdbScore" DOUBLE PRECISION,
    "tmdbVotes" INTEGER,
    "tmdbPopularity" DOUBLE PRECISION,
    "imdbScore" DOUBLE PRECISION,
    "imdbVotes" INTEGER,
    "rtCriticScore" INTEGER,
    "rtAudienceScore" INTEGER,
    "metacriticScore" INTEGER,
    "metacriticUserScore" DOUBLE PRECISION,
    "traktScore" INTEGER,
    "traktVotes" INTEGER,
    "letterboxdScore" INTEGER,
    "rogerebtScore" DOUBLE PRECISION,
    "malScore" DOUBLE PRECISION,
    "mdblistScore" INTEGER,
    "mdblistRank" INTEGER,
    "aggregateScore" DOUBLE PRECISION,
    "popularityScore" DOUBLE PRECISION,
    "mediaId" TEXT NOT NULL,

    CONSTRAINT "MediaRatings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PlexAccount_plexId_key" ON "PlexAccount"("plexId");

-- CreateIndex
CREATE UNIQUE INDEX "PlexAccount_userId_key" ON "PlexAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmbyAccount_embyId_key" ON "EmbyAccount"("embyId");

-- CreateIndex
CREATE UNIQUE INDEX "EmbyAccount_userId_key" ON "EmbyAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_token_idx" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "MediaRequest_userId_idx" ON "MediaRequest"("userId");

-- CreateIndex
CREATE INDEX "Job_status_scheduledFor_idx" ON "Job"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "Job_type_status_idx" ON "Job"("type", "status");

-- CreateIndex
CREATE INDEX "ActivityLog_timestamp_idx" ON "ActivityLog"("timestamp");

-- CreateIndex
CREATE INDEX "ActivityLog_requestId_idx" ON "ActivityLog"("requestId");

-- CreateIndex
CREATE INDEX "LibraryItem_tmdbId_type_idx" ON "LibraryItem"("tmdbId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryItem_tmdbId_type_serverId_key" ON "LibraryItem"("tmdbId", "type", "serverId");

-- CreateIndex
CREATE INDEX "MediaItem_tmdbId_type_idx" ON "MediaItem"("tmdbId", "type");

-- CreateIndex
CREATE INDEX "MediaItem_imdbId_idx" ON "MediaItem"("imdbId");

-- CreateIndex
CREATE INDEX "MediaItem_traktId_idx" ON "MediaItem"("traktId");

-- CreateIndex
CREATE INDEX "MediaItem_releaseDate_idx" ON "MediaItem"("releaseDate");

-- CreateIndex
CREATE INDEX "MediaItem_tmdbUpdatedAt_idx" ON "MediaItem"("tmdbUpdatedAt");

-- CreateIndex
CREATE INDEX "MediaItem_mdblistUpdatedAt_idx" ON "MediaItem"("mdblistUpdatedAt");

-- CreateIndex
CREATE INDEX "MediaItem_language_idx" ON "MediaItem"("language");

-- CreateIndex
CREATE INDEX "MediaItem_spokenLanguages_idx" ON "MediaItem"("spokenLanguages");

-- CreateIndex
CREATE INDEX "Season_mediaItemId_idx" ON "Season"("mediaItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Season_mediaItemId_seasonNumber_key" ON "Season"("mediaItemId", "seasonNumber");

-- CreateIndex
CREATE INDEX "Episode_seasonId_idx" ON "Episode"("seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_seasonId_episodeNumber_key" ON "Episode"("seasonId", "episodeNumber");

-- CreateIndex
CREATE UNIQUE INDEX "MediaRatings_mediaId_key" ON "MediaRatings"("mediaId");

-- CreateIndex
CREATE INDEX "MediaRatings_aggregateScore_idx" ON "MediaRatings"("aggregateScore");

-- CreateIndex
CREATE INDEX "MediaRatings_popularityScore_idx" ON "MediaRatings"("popularityScore");

-- CreateIndex
CREATE INDEX "MediaRatings_mdblistScore_idx" ON "MediaRatings"("mdblistScore");

-- AddForeignKey
ALTER TABLE "PlexAccount" ADD CONSTRAINT "PlexAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbyAccount" ADD CONSTRAINT "EmbyAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageServer" ADD CONSTRAINT "StorageServer_encodingProfileId_fkey" FOREIGN KEY ("encodingProfileId") REFERENCES "EncodingProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaRequest" ADD CONSTRAINT "MediaRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EncodingJob" ADD CONSTRAINT "EncodingJob_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EncodingJob" ADD CONSTRAINT "EncodingJob_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "EncodingProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MediaRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryItem" ADD CONSTRAINT "LibraryItem_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "StorageServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaRatings" ADD CONSTRAINT "MediaRatings_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
