#!/usr/bin/env node
require('ts-node').register({
  project: require('node:path').join(__dirname, '../tsconfig.scripts.json'),
});
const { Queue } = require('bullmq');
const { preparePlans } = require('./lib/vercel-env');
const { queueRedisUrl } = require('../src/queues/redis-connection');
const { queuePrefix } = require('../src/redis/redis-namespace');
const { failureSummary } = require('./lib/queue-failures');

async function main() {
  const [target, offsetText = '0', ...extra] = process.argv.slice(2);
  if (!['preview', 'production'].includes(target) || extra.length || !/^\d{1,6}$/.test(offsetText))
    throw new Error();
  const offset = Number(offsetText);
  const plan = preparePlans(process.cwd(), [target])[0];
  const read = (name) => (name === 'VERCEL_ENV' ? target : plan.entries[name]?.value);
  const queue = new Queue('dead-letter', {
    prefix: queuePrefix(read),
    skipMetasUpdate: true,
    connection: {
      url: queueRedisUrl(read),
      maxRetriesPerRequest: 1,
      commandTimeout: 3000,
      enableOfflineQueue: false,
    },
  });
  queue.on('error', () => {});
  try {
    const jobs = await queue.getJobs(
      ['wait', 'active', 'completed', 'failed'],
      offset,
      offset + 49,
    );
    console.log(
      JSON.stringify(
        {
          target,
          offset,
          records: jobs.filter(Boolean).map(failureSummary),
          nextOffset: jobs.length === 50 ? offset + 50 : null,
        },
        null,
        2,
      ),
    );
  } finally {
    await queue.close();
  }
}
main().catch(() => {
  console.error(
    'Failure inspection stopped. Usage: npm run queues:failures -- preview|production [offset]. Verify the target JSON and Redis access. Values were not logged.',
  );
  process.exitCode = 1;
});
