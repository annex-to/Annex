import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const requestId = '26fe8e2d-c0b0-4091-8742-0e27c87f2343';

  // Get request
  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
    select: { id: true, title: true, status: true, progress: true }
  });

  console.log('Request:', request);

  // Get episode status breakdown
  const episodes = await prisma.episode.groupBy({
    by: ['status'],
    where: { requestId },
    _count: true
  });

  console.log('\nEpisode status breakdown:');
  episodes.forEach(e => console.log(`  ${e.status}: ${e._count}`));

  // Get encoded/delivering episodes
  const encodedOrDelivering = await prisma.episode.findMany({
    where: {
      requestId,
      status: { in: ['ENCODED', 'DELIVERING'] }
    },
    select: {
      seasonNumber: true,
      episodeNumber: true,
      status: true,
      downloadItemId: true,
      outputPath: true
    },
    orderBy: [{ seasonNumber: 'asc' }, { episodeNumber: 'asc' }]
  });

  console.log(`\nEncoded/Delivering episodes (${encodedOrDelivering.length}):`,);
  encodedOrDelivering.slice(0, 10).forEach(e =>
    console.log(`  S${e.seasonNumber}E${e.episodeNumber}: ${e.status}, outputPath: ${e.outputPath ? 'YES' : 'NO'}`)
  );
  if (encodedOrDelivering.length > 10) {
    console.log(`  ... and ${encodedOrDelivering.length - 10} more`);
  }

  await prisma.$disconnect();
}

main().catch(console.error);
