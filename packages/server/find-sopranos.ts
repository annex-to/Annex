import { prisma } from './src/db/client';

async function main() {
  // Find Sopranos requests
  const requests = await prisma.mediaRequest.findMany({
    where: {
      title: {
        contains: 'Sopranos',
        mode: 'insensitive'
      }
    },
    select: {
      id: true,
      title: true,
      status: true,
      progress: true,
      createdAt: true
    },
    orderBy: { createdAt: 'desc' }
  });

  console.log(`Found ${requests.length} Sopranos request(s):`);
  for (const req of requests) {
    console.log(`\n  ID: ${req.id}`);
    console.log(`  Title: ${req.title}`);
    console.log(`  Status: ${req.status}`);
    console.log(`  Progress: ${req.progress}%`);
    console.log(`  Created: ${req.createdAt}`);

    // Count processing items
    const itemCount = await prisma.processingItem.count({
      where: { requestId: req.id, type: 'EPISODE' }
    });
    console.log(`  Episodes: ${itemCount}`);

    // Status breakdown
    const statuses = await prisma.processingItem.groupBy({
      by: ['status'],
      where: { requestId: req.id, type: 'EPISODE' },
      _count: true
    });

    if (statuses.length > 0) {
      console.log('  Status breakdown:');
      statuses.forEach(s => console.log(`    ${s.status}: ${s._count}`));
    }
  }

  await prisma.$disconnect();
}

main().catch(console.error);
