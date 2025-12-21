/**
 * Media Test Fixtures - Common media items for testing
 */

import { MediaType } from "@prisma/client";

export const MOVIES = {
  INCEPTION: {
    type: MediaType.MOVIE,
    tmdbId: 27205,
    title: "Inception",
    year: 2010,
  },
  DARK_KNIGHT: {
    type: MediaType.MOVIE,
    tmdbId: 155,
    title: "The Dark Knight",
    year: 2008,
  },
  INTERSTELLAR: {
    type: MediaType.MOVIE,
    tmdbId: 157336,
    title: "Interstellar",
    year: 2014,
  },
};

export const TV_SHOWS = {
  BREAKING_BAD: {
    type: MediaType.TV,
    tmdbId: 1396,
    title: "Breaking Bad",
    year: 2008,
  },
  BETTER_CALL_SAUL: {
    type: MediaType.TV,
    tmdbId: 60059,
    title: "Better Call Saul",
    year: 2015,
  },
  THE_WIRE: {
    type: MediaType.TV,
    tmdbId: 1438,
    title: "The Wire",
    year: 2002,
  },
};

export const TARGETS = {
  SINGLE_4K_SERVER: [
    {
      serverId: "test-server-4k",
      encodingProfileId: "profile-4k",
    },
  ],
  SINGLE_1080P_SERVER: [
    {
      serverId: "test-server-1080p",
    },
  ],
  MULTI_SERVER: [
    {
      serverId: "test-server-4k",
      encodingProfileId: "profile-4k",
    },
    {
      serverId: "test-server-1080p",
      encodingProfileId: "profile-1080p",
    },
  ],
};
