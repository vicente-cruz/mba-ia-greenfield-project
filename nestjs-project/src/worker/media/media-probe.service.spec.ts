import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import queueConfig from '../../config/queue.config';
import { StorageService } from '../../storage/storage.service';
import { MediaRejectedError, MediaTransientError } from './media.errors';
import { MediaProbeService } from './media-probe.service';
import type { FfprobeOutput } from './media-probe.rules';
import {
  type MediaProcessResult,
  MediaProcessRunner,
} from './media-process.runner';

const KEY = 'originals/video-1/session-1';
const SIGNED_URL =
  'http://storage:9000/streamtube/originals/video-1/session-1?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=app%2F20261123&X-Amz-Signature=0123456789abcdef';
const NETWORK_ARGS = [
  '-rw_timeout',
  '10000000',
  '-reconnect',
  '1',
  '-reconnect_on_network_error',
  '1',
  '-reconnect_delay_max',
  '4',
];
const MP4_FORMAT = 'mov,mp4,m4a,3gp,3g2,mj2';
const WEBM_FORMAT = 'matroska,webm';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

function processResult(
  overrides: Partial<MediaProcessResult> = {},
): MediaProcessResult {
  return {
    code: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: '',
    timedOut: false,
    durationMs: 80,
    ...overrides,
  };
}

function ffprobeJson(output: FfprobeOutput): MediaProcessResult {
  return processResult({ stdout: Buffer.from(JSON.stringify(output)) });
}

const video = (codec: string, width = 320, height = 240) => ({
  codec_type: 'video',
  codec_name: codec,
  width,
  height,
});
const audio = (codec: string) => ({ codec_type: 'audio', codec_name: codec });

describe('MediaProbeService', () => {
  let service: MediaProbeService;
  let runner: { run: jest.Mock };
  let storage: { presignGet: jest.Mock };

  beforeEach(async () => {
    runner = { run: jest.fn() };
    storage = {
      presignGet: jest.fn().mockResolvedValue({
        url: SIGNED_URL,
        expiresAt: new Date(),
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MediaProbeService,
        { provide: MediaProcessRunner, useValue: runner },
        { provide: StorageService, useValue: storage },
        {
          provide: queueConfig.KEY,
          useValue: { videoProcessing: { timeoutMs: 60_000 } },
        },
      ],
    }).compile();
    service = moduleRef.get(MediaProbeService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function probeReturns(result: MediaProcessResult) {
    runner.run.mockResolvedValue(result);
  }

  describe('calls of ffprobe and ffmpeg', () => {
    it('should run ffprobe in JSON over the internal presigned URL, with the network options and the per-call timeout of V-04', async () => {
      probeReturns(
        ffprobeJson({
          streams: [video('h264')],
          format: { format_name: MP4_FORMAT, duration: '2.000000' },
        }),
      );

      await service.probe(KEY, 'video/mp4');

      expect(storage.presignGet).toHaveBeenCalledWith({
        key: KEY,
        audience: 'internal',
        expiresInSeconds: 120,
      });
      expect(runner.run).toHaveBeenCalledWith(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          ...NETWORK_ARGS,
          SIGNED_URL,
        ],
        60_000,
      );
    });

    it('should extract one JPEG frame with -ss before -i, as image2pipe', async () => {
      probeReturns(processResult({ stdout: JPEG }));

      await expect(service.extractFrame(KEY, 1)).resolves.toEqual(JPEG);

      const [command, args, timeoutMs] = runner.run.mock.calls[0] as [
        string,
        string[],
        number,
      ];
      expect(command).toBe('ffmpeg');
      expect(timeoutMs).toBe(60_000);
      expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
      expect(args.slice(args.indexOf('-ss'), args.indexOf('-i') + 2)).toEqual([
        '-ss',
        '1',
        '-i',
        SIGNED_URL,
      ]);
      expect(args.slice(0, args.indexOf('-ss'))).toEqual(
        expect.arrayContaining(NETWORK_ARGS) as unknown,
      );
      expect(args.slice(args.indexOf(SIGNED_URL) + 1)).toEqual([
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ]);
    });

    it('should refuse a negative frame position without running ffmpeg', async () => {
      await expect(service.extractFrame(KEY, -1)).rejects.toBeInstanceOf(
        RangeError,
      );
      expect(runner.run).not.toHaveBeenCalled();
    });
  });

  describe('JSON of ffprobe: accepted media', () => {
    it.each([
      [
        'MP4 with H.264 and AAC',
        'video/mp4',
        [video('h264'), audio('aac')],
        MP4_FORMAT,
        'aac',
      ],
      ['MP4 without audio', 'video/mp4', [video('h264')], MP4_FORMAT, null],
      [
        'WebM with VP9 and Opus',
        'video/webm',
        [video('vp9'), audio('opus')],
        WEBM_FORMAT,
        'opus',
      ],
      [
        'WebM with VP8 and Vorbis',
        'video/webm',
        [video('vp8'), audio('vorbis')],
        WEBM_FORMAT,
        'vorbis',
      ],
      [
        'WebM with AV1 without audio',
        'video/webm',
        [video('av1')],
        WEBM_FORMAT,
        null,
      ],
    ])(
      'should accept %s and read its metadata',
      async (_, contentType, streams, formatName, audioCodec) => {
        probeReturns(
          ffprobeJson({
            streams,
            format: { format_name: formatName, duration: '2.008000' },
          }),
        );

        await expect(service.probe(KEY, contentType)).resolves.toEqual({
          durationSeconds: 2.008,
          width: 320,
          height: 240,
          mediaFormat: formatName,
          videoCodec: streams[0].codec_name,
          audioCodec,
        });
      },
    );

    it.each([undefined, 'N/A'])(
      'should keep a null duration when ffprobe gives %s',
      async (duration) => {
        probeReturns(
          ffprobeJson({
            streams: [video('h264')],
            format: { format_name: MP4_FORMAT, duration },
          }),
        );

        await expect(service.probe(KEY, 'video/mp4')).resolves.toMatchObject({
          durationSeconds: null,
        });
      },
    );
  });

  describe('JSON of ffprobe: refused media (permanent)', () => {
    it.each<[string, string, FfprobeOutput, string, RegExp]>([
      [
        'a file without a video stream',
        'video/mp4',
        { streams: [audio('aac')], format: { format_name: MP4_FORMAT } },
        'MEDIA_INVALID',
        /no video stream/,
      ],
      [
        'a video stream without dimensions',
        'video/mp4',
        {
          streams: [{ codec_type: 'video', codec_name: 'h264' }],
          format: { format_name: MP4_FORMAT },
        },
        'MEDIA_INVALID',
        /no dimensions/,
      ],
      [
        'a MOV (major_brand qt) declared as MP4',
        'video/mp4',
        {
          streams: [video('h264'), audio('aac')],
          format: { format_name: MP4_FORMAT, tags: { major_brand: 'qt  ' } },
        },
        'MEDIA_CONTAINER_MISMATCH',
        /major_brand qt {2}/,
      ],
      [
        'a WebM declared as MP4',
        'video/mp4',
        { streams: [video('vp9')], format: { format_name: WEBM_FORMAT } },
        'MEDIA_CONTAINER_MISMATCH',
        /format_name matroska,webm/,
      ],
      [
        'an MP4 declared as WebM',
        'video/webm',
        { streams: [video('h264')], format: { format_name: MP4_FORMAT } },
        'MEDIA_CONTAINER_MISMATCH',
        /format_name mov,mp4/,
      ],
      [
        'a type outside the accepted ones',
        'video/quicktime',
        { streams: [video('h264')], format: { format_name: MP4_FORMAT } },
        'MEDIA_CONTAINER_MISMATCH',
        /video\/quicktime/,
      ],
      [
        'HEVC in MP4',
        'video/mp4',
        { streams: [video('hevc')], format: { format_name: MP4_FORMAT } },
        'MEDIA_UNSUPPORTED_CODEC',
        /video:hevc/,
      ],
      [
        'Opus audio in MP4',
        'video/mp4',
        {
          streams: [video('h264'), audio('opus')],
          format: { format_name: MP4_FORMAT },
        },
        'MEDIA_UNSUPPORTED_CODEC',
        /audio:opus/,
      ],
      [
        'H.264 in WebM',
        'video/webm',
        { streams: [video('h264')], format: { format_name: WEBM_FORMAT } },
        'MEDIA_UNSUPPORTED_CODEC',
        /video:h264/,
      ],
      [
        'AAC audio in WebM',
        'video/webm',
        {
          streams: [video('vp9'), audio('aac')],
          format: { format_name: WEBM_FORMAT },
        },
        'MEDIA_UNSUPPORTED_CODEC',
        /audio:aac/,
      ],
    ])('should refuse %s', async (_, contentType, output, code, reason) => {
      probeReturns(ffprobeJson(output));

      const error = await service
        .probe(KEY, contentType)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MediaRejectedError);
      expect(error).toMatchObject({ code });
      expect((error as MediaRejectedError).reason).toMatch(reason);
    });
  });

  describe('failures of the process (V-04)', () => {
    it('should give the per-call timeout as a transient failure', async () => {
      probeReturns(
        processResult({
          code: null,
          signal: 'SIGKILL',
          timedOut: true,
          durationMs: 60_003,
        }),
      );

      const error = await service
        .probe(KEY, 'video/mp4')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MediaTransientError);
      expect((error as MediaTransientError).reason).toMatch(/per-call timeout/);
    });

    it.each([
      'Connection timed out',
      'Connection refused',
      'Connection reset by peer',
      'Broken pipe',
      'Network is unreachable',
      'Server returned 404 Not Found',
      'Server returned 5XX Server Error reply',
      'Input/output error',
      'Stream ends prematurely at 10000, should be 34363',
    ])(
      'should give "%s" as a transient failure, even with a parsing message after it',
      async (transport) => {
        probeReturns(
          processResult({
            code: 1,
            stderr: `${SIGNED_URL}: ${transport}\nmoov atom not found\nInvalid data found when processing input\n`,
          }),
        );

        await expect(service.probe(KEY, 'video/mp4')).rejects.toBeInstanceOf(
          MediaTransientError,
        );
      },
    );

    it.each([
      'Invalid data found when processing input',
      'moov atom not found',
    ])(
      'should give "%s" without evidence of transport as MEDIA_INVALID',
      async (parsing) => {
        probeReturns(
          processResult({ code: 1, stderr: `${SIGNED_URL}: ${parsing}\n` }),
        );

        await expect(service.probe(KEY, 'video/mp4')).rejects.toMatchObject({
          code: 'MEDIA_INVALID',
        });
      },
    );

    it('should give a failure without a media cause as transient, never as a validation of the media', async () => {
      probeReturns(
        processResult({ code: 1, stderr: 'Something unexpected\n' }),
      );

      await expect(service.probe(KEY, 'video/mp4')).rejects.toBeInstanceOf(
        MediaTransientError,
      );
    });

    it('should give a successful exit without a JSON object as transient', async () => {
      probeReturns(processResult({ stdout: Buffer.from('not json') }));

      await expect(service.probe(KEY, 'video/mp4')).rejects.toBeInstanceOf(
        MediaTransientError,
      );
    });
  });

  describe('signed URLs in the messages', () => {
    it('should remove the query of the presigned URL from the cause and from the log', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      probeReturns(
        processResult({
          code: 1,
          stderr: `${SIGNED_URL}: Invalid data found when processing input\n`,
        }),
      );

      const error = (await service
        .probe(KEY, 'video/mp4')
        .catch((caught: unknown) => caught)) as MediaRejectedError;

      expect(error.reason).toBe(
        'http://storage:9000/streamtube/originals/video-1/session-1: Invalid data found when processing input',
      );
      const logged = warn.mock.calls.map(([message]) => String(message)).join();
      expect(logged).toContain(
        'http://storage:9000/streamtube/originals/video-1/session-1',
      );
      expect(logged).not.toMatch(/X-Amz-|\?/);
      expect(error.message).not.toMatch(/X-Amz-/);
    });
  });

  describe('frame', () => {
    it.each([
      ['no output', Buffer.alloc(0)],
      ['an output that is not a JPEG', Buffer.from('PNG?')],
    ])(
      'should give %s on a successful exit as MEDIA_INVALID',
      async (_, stdout) => {
        probeReturns(processResult({ stdout }));

        await expect(service.extractFrame(KEY, 1)).rejects.toMatchObject({
          code: 'MEDIA_INVALID',
        });
      },
    );

    it('should classify a failed ffmpeg like ffprobe: the timeout is transient', async () => {
      probeReturns(
        processResult({ code: null, signal: 'SIGKILL', timedOut: true }),
      );

      await expect(service.extractFrame(KEY, 1)).rejects.toBeInstanceOf(
        MediaTransientError,
      );
    });
  });
});
