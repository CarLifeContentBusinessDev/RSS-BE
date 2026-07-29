import { Injectable, Logger } from '@nestjs/common';
import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { r2Config } from '../../common/config/r2.config';

@Injectable()
export class R2StorageService {
  private readonly logger = new Logger(R2StorageService.name);
  private readonly s3Client: S3Client;

  constructor() {
    if (
      !r2Config.endpoint ||
      !r2Config.accessKeyId ||
      !r2Config.secretAccessKey
    ) {
      throw new Error('R2 환경변수 설정을 확인해주세요.');
    }

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: r2Config.endpoint,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
      },
    });
  }

  // r2Config.publicUrl로 시작하는 URL에서만 오브젝트 키를 추출한다 (R2가 아닌 외부 URL은 null)
  extractKey(url?: string | null): string | null {
    if (!url || !r2Config.publicUrl) return null;
    const prefix = `${r2Config.publicUrl}/`;
    if (!url.startsWith(prefix)) return null;
    return url.slice(prefix.length);
  }

  async deleteObjects(keys: string[]): Promise<void> {
    const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
    if (uniqueKeys.length === 0) return;

    // DeleteObjects는 요청당 최대 1000개 키까지 허용된다
    const chunkSize = 1000;
    for (let i = 0; i < uniqueKeys.length; i += chunkSize) {
      const chunk = uniqueKeys.slice(i, i + chunkSize);
      await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: r2Config.bucketName,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        }),
      );
    }

    this.logger.log(`R2 오브젝트 ${uniqueKeys.length}개 삭제 완료`);
  }
}
