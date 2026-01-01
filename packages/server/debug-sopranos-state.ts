import { prisma } from './src/db/client';

async function main() {
  const requestId = '26fe8e2d-c0b0-4091-8742-0e27c87f2343';

  // Get request
  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
    select: { id: true, title: true, status: true, progress: true }
  });

  console.log('Request:', request);

  // Get episode status breakdown
  const episodes = await prisma.processingItem.groupBy({
    by: ['status'],
    where: { requestId, type: 'EPISODE' },
    _count: true
  });

  console.log('\nEpisode status breakdown:');
  episodes.forEach(e => console.log(`  ${e.status}: ${e._count}`));

  // Get encoded/delivering episodes
  const encodedOrDelivering = await prisma.processingItem.findMany({
    where: {
      requestId,
      type: 'EPISODE',
      status: { in: ['ENCODED', 'DELIVERING'] }
    },
    select: {
      season: true,
      episode: true,
      status: true,
      downloadId: true,
      sourceFilePath: true,
      currentStep: true
    },
    orderBy: [{ season: 'asc' }, { episode: 'asc' }]
  });

  console.log(`\nEncoded/Delivering episodes (${encodedOrDelivering.length}):`);
  encodedOrDelivering.slice(0, 15).forEach(e =>
    console.log(`  S${e.season}E${e.episode}: ${e.status} (step: ${e.currentStep}, file: ${e.sourceFilePath ? 'YES' : 'NO'})`)
  );
  if (encodedOrDelivering.length > 15) {
    console.log(`  ... and ${encodedOrDelivering.length - 15} more`);
  }

  // Get total counts
  const total = await prisma.processingItem.count({ where: { requestId, type: 'EPISODE' } });
  console.log(`\nTotal episodes: ${total}`);

  await prisma.$disconnect();
}

main().catch(console.error);
