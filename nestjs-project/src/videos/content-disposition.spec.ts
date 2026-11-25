import { parseContentDisposition } from '../test/content-disposition';
import { attachmentDisposition } from './content-disposition';

/** `attr-char` of RFC 8187, the only characters left unencoded in `filename*`. */
const EXT_VALUE = /^(?:[A-Za-z0-9!#$&+\-.^_`|~]|%[0-9A-F]{2})*$/;

describe('attachmentDisposition', () => {
  it('should carry the exact accented name in filename* and a name without diacritics in filename', () => {
    const header = attachmentDisposition('vídeo de ação.mp4');

    expect(header).toBe(
      `attachment; filename="video de acao.mp4"; filename*=UTF-8''v%C3%ADdeo%20de%20a%C3%A7%C3%A3o.mp4`,
    );
    expect(parseContentDisposition(header)).toEqual({
      type: 'attachment',
      filename: 'video de acao.mp4',
      filenameStar: 'vídeo de ação.mp4',
    });
  });

  it.each([
    ['clip.mp4'],
    ['clip "final" 100%; v2\'s (copy)*.mp4'],
    ['back\\slash.webm'],
    ['動画 テスト.mp4'],
    ['🎬 trailer.webm'],
    ['ﬁnal ½.mp4'],
  ])('should round-trip %j in filename* and keep the header ASCII', (name) => {
    const header = attachmentDisposition(name);
    const parsed = parseContentDisposition(header);

    expect(parsed.type).toBe('attachment');
    expect(parsed.filenameStar).toBe(name);
    expect(header).toMatch(/^[\x20-\x7e]*$/);
    expect(header.split("filename*=UTF-8''")[1]).toMatch(EXT_VALUE);
    expect(parsed.filename).toMatch(/^[\x20-\x7e]*$/);
    expect(parsed.filename).not.toMatch(/["\\%]/);
  });

  it.each([
    ['clip "final" 100%.mp4', 'clip _final_ 100_.mp4'],
    ['動画.mp4', '__.mp4'],
    ['🎬 trailer.webm', '_ trailer.webm'],
    // NFKD turns the ligature into `fi` and ½ into 1, FRACTION SLASH (U+2044) and 2.
    ['ﬁnal ½.mp4', 'final 1_2.mp4'],
  ])(
    'should replace, in the fallback of %j, what ASCII cannot carry by _',
    (name, fallback) => {
      expect(
        parseContentDisposition(attachmentDisposition(name)).filename,
      ).toBe(fallback);
    },
  );
});
