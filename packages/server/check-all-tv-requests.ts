import { prisma } from './src/db/client';

async function main() {
  // Find all TV requests
  const requests = await prisma.mediaRequest.findMany({
    where: {
      type: 'TV'
    },
    select: {
      id: true,
      title: true,
      status: true,
      progress: true,
      createdAt: true
    },
    orderBy: { createdAt: 'desc' },
    take: 20
  });

  console.log(`Found ${requests.length} TV request(s):`);
  for (const req of requests) {
    console.log(`\n  ${req.title}`);
    console.log(`    ID: ${req.id}`);
    console.log(`    Status: ${req.status}`);
    console.log(`    Progress: ${req.progress}%`);

    // Count processing items
    const itemCount = await prisma.processingItem.count({
      where: { requestId: req.id, type: 'EPISODE' }
    });
    console.log(`    Episodes: ${itemCount}`);

    // Status breakdown
    const statuses = await prisma.processingItem.groupBy({
      by: ['status'],
      where: { requestId: req.id, type: 'EPISODE' },
      _count: true
    });

    if (statuses.length > 0) {
      console.log('    Breakdown:');
      statuses.forEach(s => console.log(`      ${s.status}: ${s._count}`));
    }
  }

  await prisma.$disconnect();
}

main().catch(console.error);
