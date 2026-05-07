import 'dotenv/config';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  _Object,
} from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

type ChannelRow = {
  videos: unknown;
};

type VideoLike = {
  audioPath?: unknown;
};

type CleanupReport = {
  scannedPrefix: string;
  totalObjects: number;
  totalSizeBytes: number;
  directoryPlaceholderCount: number;
  referencedKeys: number;
  zeroByteCount: number;
  zeroByteReferencedCount: number;
  zeroByteUnreferencedCount: number;
  unreferencedNonZeroCount: number;
  unreferencedCount: number;
  deleteCandidateCount: number;
  deleteCandidateTotalSizeBytes: number;
  sampleDeleteCandidates: string[];
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '');
}

function toKeyFromAudioPath(
  audioPath: string,
  r2PublicUrl: string,
): string | null {
  if (!audioPath) return null;

  const normalizedBase = r2PublicUrl.replace(/\/+$/, '');
  if (audioPath.startsWith(`${normalizedBase}/`)) {
    return normalizePath(audioPath.slice(normalizedBase.length + 1));
  }

  try {
    const parsed = new URL(audioPath);
    return normalizePath(parsed.pathname);
  } catch {
    return null;
  }
}

async function listAllObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<_Object[]> {
  const all: _Object[] = [];
  let continuationToken: string | undefined;

  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    if (resp.Contents?.length) {
      all.push(...resp.Contents);
    }

    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);

  return all;
}

async function getReferencedKeys(
  supabaseUrl: string,
  supabaseAnonKey: string,
  r2PublicUrl: string,
): Promise<Set<string>> {
  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const referenced = new Set<string>();

  const { data, error } = await supabase.from('channels').select('videos');

  if (error) {
    throw new Error(`Failed to read channels.videos: ${error.message}`);
  }

  const rows = (data || []) as ChannelRow[];

  for (const row of rows) {
    if (!Array.isArray(row.videos)) continue;

    for (const item of row.videos as VideoLike[]) {
      if (!item || typeof item !== 'object') continue;
      const audioPath = item.audioPath;
      if (typeof audioPath !== 'string') continue;

      const key = toKeyFromAudioPath(audioPath, r2PublicUrl);
      if (key) referenced.add(key);
    }
  }

  return referenced;
}

async function deleteKeys(
  client: S3Client,
  bucket: string,
  keys: string[],
): Promise<number> {
  const chunkSize = 1000;
  let deleted = 0;

  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const resp = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: chunk.map((k) => ({ Key: k })),
        },
      }),
    );

    const errorCount = resp.Errors?.length || 0;
    deleted += chunk.length - errorCount;

    if (resp.Errors?.length) {
      const msg = resp.Errors.map((e) => `${e.Key}: ${e.Message}`).join('; ');
      throw new Error(`DeleteObjects partial failure: ${msg}`);
    }
  }

  return deleted;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const onlyZero = process.argv.includes('--only-zero');
  const includeReferencedZero = process.argv.includes(
    '--include-referenced-zero',
  );

  const r2Endpoint = requiredEnv('R2_ENDPOINT');
  const r2AccessKeyId = requiredEnv('R2_ACCESS_KEY_ID');
  const r2SecretAccessKey = requiredEnv('R2_SECRET_ACCESS_KEY');
  const r2BucketName = requiredEnv('R2_BUCKET_NAME');
  const r2PublicUrl = requiredEnv('R2_PUBLIC_URL');
  const downloadFolder = requiredEnv('DOWNLOAD_FOLDER');

  const supabaseUrl = requiredEnv('SUPABASE_URL');
  const supabaseAnonKey = requiredEnv('SUPABASE_ANON_KEY');

  const prefix = `${downloadFolder.replace(/\/+$/, '')}/`;

  const s3 = new S3Client({
    region: 'auto',
    endpoint: r2Endpoint,
    credentials: {
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
    },
  });

  const [objects, referencedKeys] = await Promise.all([
    listAllObjects(s3, r2BucketName, prefix),
    getReferencedKeys(supabaseUrl, supabaseAnonKey, r2PublicUrl),
  ]);

  const objectKeys = objects
    .map((o) => o.Key)
    .filter((k): k is string => typeof k === 'string');
  const fileObjectKeys = objectKeys.filter((k) => !k.endsWith('/'));

  const zeroByteKeys = objects
    .filter((o) => (o.Size || 0) === 0 && !String(o.Key || '').endsWith('/'))
    .map((o) => o.Key)
    .filter((k): k is string => typeof k === 'string');

  const unreferencedKeys = fileObjectKeys.filter(
    (key) => !referencedKeys.has(key),
  );
  const zeroByteReferencedKeys = zeroByteKeys.filter((key) =>
    referencedKeys.has(key),
  );
  const zeroByteUnreferencedKeys = zeroByteKeys.filter(
    (key) => !referencedKeys.has(key),
  );
  const unreferencedNonZeroKeys = unreferencedKeys.filter(
    (key) => !zeroByteUnreferencedKeys.includes(key),
  );

  const deleteSet = new Set<string>();
  if (onlyZero) {
    for (const key of zeroByteUnreferencedKeys) deleteSet.add(key);
  } else {
    for (const key of unreferencedKeys) deleteSet.add(key);
  }

  // Optional unsafe mode when you intentionally want to purge referenced 0-byte keys.
  if (includeReferencedZero) {
    for (const key of zeroByteReferencedKeys) deleteSet.add(key);
  }

  const deleteCandidates = Array.from(deleteSet);

  const sizeByKey = new Map<string, number>();
  for (const obj of objects) {
    if (!obj.Key) continue;
    sizeByKey.set(obj.Key, obj.Size || 0);
  }

  const report: CleanupReport = {
    scannedPrefix: prefix,
    totalObjects: fileObjectKeys.length,
    totalSizeBytes: objects.reduce((acc, o) => acc + (o.Size || 0), 0),
    directoryPlaceholderCount: objectKeys.length - fileObjectKeys.length,
    referencedKeys: referencedKeys.size,
    zeroByteCount: zeroByteKeys.length,
    zeroByteReferencedCount: zeroByteReferencedKeys.length,
    zeroByteUnreferencedCount: zeroByteUnreferencedKeys.length,
    unreferencedNonZeroCount: unreferencedNonZeroKeys.length,
    unreferencedCount: unreferencedKeys.length,
    deleteCandidateCount: deleteCandidates.length,
    deleteCandidateTotalSizeBytes: deleteCandidates.reduce(
      (acc, key) => acc + (sizeByKey.get(key) || 0),
      0,
    ),
    sampleDeleteCandidates: deleteCandidates.slice(0, 30),
  };

  console.log('\n=== R2 YouTube Cleanup Report (Dry Run) ===');
  console.log(JSON.stringify(report, null, 2));

  if (!apply) {
    console.log('\nNo deletion executed (dry run).');
    console.log('Run with --apply to delete candidates.');
    console.log('Use --only-zero to delete only unreferenced 0-byte objects.');
    console.log(
      'Use --include-referenced-zero only if you intentionally want to delete referenced 0-byte objects.',
    );
    return;
  }

  if (deleteCandidates.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  const deleted = await deleteKeys(s3, r2BucketName, deleteCandidates);
  console.log(`\nDeleted objects: ${deleted}/${deleteCandidates.length}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
