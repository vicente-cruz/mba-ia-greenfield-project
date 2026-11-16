import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { DeepPartial, FindOneOptions } from 'typeorm';
import authConfig from '../config/auth.config';
import {
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  TokenExpiredException,
  TokenReuseDetectedException,
} from '../common/exceptions/domain.exception';
import { Channel } from '../channels/entities/channel.entity';
import { MailService } from '../mail/mail.service';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import {
  VerificationToken,
  VerificationTokenType,
} from './entities/verification-token.entity';

const mockAuthConfig = {
  jwtSecret: 'test-secret',
  jwtRefreshSecret: 'test-refresh-secret',
  jwtAccessExpiration: '15m',
  jwtRefreshExpiration: '7d',
  confirmationTokenExpirationHours: 1,
  passwordResetTokenExpirationHours: 1,
};

type MethodMock<F extends (...args: never[]) => unknown> = jest.Mock<
  ReturnType<F>,
  Parameters<F>
>;

/** UsersService methods used by AuthService. */
interface UsersServiceMock {
  findByEmail: MethodMock<UsersService['findByEmail']>;
  findByEmailWithChannel: MethodMock<UsersService['findByEmailWithChannel']>;
  createUserWithChannel: MethodMock<UsersService['createUserWithChannel']>;
  save: MethodMock<UsersService['save']>;
}

/** MailService methods used by AuthService. */
interface MailServiceMock {
  sendConfirmationEmail: MethodMock<MailService['sendConfirmationEmail']>;
  sendPasswordResetEmail: MethodMock<MailService['sendPasswordResetEmail']>;
}

/** Fluent update query builder chain used by AuthService. */
interface UpdateQueryBuilderMock {
  update: jest.Mock<UpdateQueryBuilderMock, []>;
  set: jest.Mock<UpdateQueryBuilderMock, [Record<string, unknown>]>;
  where: jest.Mock<UpdateQueryBuilderMock, [string, Record<string, unknown>?]>;
  andWhere: jest.Mock<
    UpdateQueryBuilderMock,
    [string, Record<string, unknown>?]
  >;
  execute: jest.Mock<Promise<void>, []>;
}

/** Repository methods used by AuthService. */
interface RepositoryMock<T> {
  create: jest.Mock<T, [DeepPartial<T>]>;
  save: jest.Mock<Promise<T>, [T]>;
  findOne: jest.Mock<Promise<T | null>, [FindOneOptions<T>]>;
  createQueryBuilder: jest.Mock<UpdateQueryBuilderMock, []>;
}

interface AuthServiceMocks {
  usersService: UsersServiceMock;
  mailService: MailServiceMock;
  verificationTokenRepository: RepositoryMock<VerificationToken>;
  refreshTokenRepository: RepositoryMock<RefreshToken>;
}

function createRepositoryMock<T>(): RepositoryMock<T> {
  return {
    create: jest.fn<T, [DeepPartial<T>]>(),
    save: jest.fn((entity: T) => Promise.resolve(entity)),
    findOne: jest.fn<Promise<T | null>, [FindOneOptions<T>]>(),
    createQueryBuilder: jest.fn<UpdateQueryBuilderMock, []>(),
  };
}

function createAuthServiceMocks(): AuthServiceMocks {
  const refreshTokenRepository = createRepositoryMock<RefreshToken>();
  refreshTokenRepository.create.mockReturnValue(new RefreshToken());

  return {
    usersService: {
      findByEmail: jest.fn<Promise<User | null>, [string]>(),
      findByEmailWithChannel: jest.fn<Promise<User | null>, [string]>(),
      createUserWithChannel: jest.fn<Promise<User>, [string, string]>(),
      save: jest.fn((user: User) => Promise.resolve(user)),
    },
    mailService: {
      sendConfirmationEmail: jest
        .fn<Promise<void>, [string, string, string]>()
        .mockResolvedValue(undefined),
      sendPasswordResetEmail: jest
        .fn<Promise<void>, [string, string, string]>()
        .mockResolvedValue(undefined),
    },
    verificationTokenRepository: createRepositoryMock<VerificationToken>(),
    refreshTokenRepository,
  };
}

function createUpdateQueryBuilderMock(): UpdateQueryBuilderMock {
  return {
    update: jest.fn<UpdateQueryBuilderMock, []>().mockReturnThis(),
    set: jest
      .fn<UpdateQueryBuilderMock, [Record<string, unknown>]>()
      .mockReturnThis(),
    where: jest
      .fn<UpdateQueryBuilderMock, [string, Record<string, unknown>?]>()
      .mockReturnThis(),
    andWhere: jest
      .fn<UpdateQueryBuilderMock, [string, Record<string, unknown>?]>()
      .mockReturnThis(),
    execute: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), overrides);
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return Object.assign(new Channel(), overrides);
}

function makeVerificationToken(
  overrides: Partial<VerificationToken> = {},
): VerificationToken {
  return Object.assign(new VerificationToken(), overrides);
}

function makeRefreshToken(overrides: Partial<RefreshToken> = {}): RefreshToken {
  return Object.assign(new RefreshToken(), overrides);
}

function buildTestModule(mocks: AuthServiceMocks) {
  return Test.createTestingModule({
    imports: [
      JwtModule.register({
        secret: 'test-secret',
        signOptions: { expiresIn: '15m' },
      }),
    ],
    providers: [
      AuthService,
      { provide: UsersService, useValue: mocks.usersService },
      { provide: MailService, useValue: mocks.mailService },
      {
        provide: getRepositoryToken(VerificationToken),
        useValue: mocks.verificationTokenRepository,
      },
      {
        provide: getRepositoryToken(RefreshToken),
        useValue: mocks.refreshTokenRepository,
      },
      {
        provide: authConfig.KEY,
        useValue: mockAuthConfig,
      },
    ],
  }).compile();
}

// Asymmetric matcher typed as unknown so it can sit inside object literals.
const anyDate: unknown = expect.any(Date);

describe('AuthService — register', () => {
  let authService: AuthService;
  let usersService: UsersServiceMock;
  let mailService: MailServiceMock;
  let verificationTokenRepository: RepositoryMock<VerificationToken>;

  beforeEach(async () => {
    const mocks = createAuthServiceMocks();
    const module = await buildTestModule(mocks);
    authService = module.get(AuthService);
    usersService = mocks.usersService;
    mailService = mocks.mailService;
    verificationTokenRepository = mocks.verificationTokenRepository;
  });

  it('throws EmailAlreadyExistsException when email is already registered', async () => {
    usersService.findByEmail.mockResolvedValue(
      makeUser({
        id: 'u1',
        email: 'test@example.com',
      }),
    );

    await expect(
      authService.register({
        email: 'test@example.com',
        password: 'password123',
      }),
    ).rejects.toThrow(EmailAlreadyExistsException);
  });

  it('hashes the password before creating the user', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.createUserWithChannel.mockResolvedValue(
      makeUser({
        id: 'u1',
        email: 'new@example.com',
        channel: makeChannel({ name: 'new' }),
      }),
    );
    verificationTokenRepository.create.mockReturnValue(new VerificationToken());

    await authService.register({
      email: 'new@example.com',
      password: 'plaintext',
    });

    const [, hashedPassword] = usersService.createUserWithChannel.mock.calls[0];
    expect(hashedPassword).not.toBe('plaintext');
    expect(hashedPassword).toMatch(/^\$argon2/);
  });

  it('calls createUserWithChannel with the correct email', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.createUserWithChannel.mockResolvedValue(
      makeUser({
        id: 'u1',
        email: 'new@example.com',
        channel: makeChannel({ name: 'new' }),
      }),
    );
    verificationTokenRepository.create.mockReturnValue(new VerificationToken());

    await authService.register({
      email: 'new@example.com',
      password: 'password123',
    });

    expect(usersService.createUserWithChannel).toHaveBeenCalledWith(
      'new@example.com',
      expect.any(String),
    );
  });

  it('stores a verification token with EMAIL_CONFIRMATION type', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.createUserWithChannel.mockResolvedValue(
      makeUser({
        id: 'u1',
        email: 'new@example.com',
        channel: makeChannel({ name: 'new' }),
      }),
    );
    const createdToken = makeVerificationToken({
      type: VerificationTokenType.EMAIL_CONFIRMATION,
    });
    verificationTokenRepository.create.mockReturnValue(createdToken);

    await authService.register({
      email: 'new@example.com',
      password: 'password123',
    });

    expect(verificationTokenRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: 'u1',
      }),
    );
    expect(verificationTokenRepository.save).toHaveBeenCalledWith(createdToken);
  });

  it('sends a confirmation email with the raw token', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.createUserWithChannel.mockResolvedValue(
      makeUser({
        id: 'u1',
        email: 'new@example.com',
        channel: makeChannel({ name: 'mynick' }),
      }),
    );
    verificationTokenRepository.create.mockReturnValue(new VerificationToken());

    await authService.register({
      email: 'new@example.com',
      password: 'password123',
    });

    expect(mailService.sendConfirmationEmail).toHaveBeenCalledWith(
      'new@example.com',
      'mynick',
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  });

  it('returns the user id and email', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.createUserWithChannel.mockResolvedValue(
      makeUser({
        id: 'u1',
        email: 'new@example.com',
        channel: makeChannel({ name: 'new' }),
      }),
    );
    verificationTokenRepository.create.mockReturnValue(new VerificationToken());

    const result = await authService.register({
      email: 'new@example.com',
      password: 'password123',
    });

    expect(result).toEqual({ id: 'u1', email: 'new@example.com' });
  });
});

describe('AuthService — confirm', () => {
  let authService: AuthService;
  let usersService: UsersServiceMock;
  let verificationTokenRepository: RepositoryMock<VerificationToken>;

  beforeEach(async () => {
    const mocks = createAuthServiceMocks();
    const module = await buildTestModule(mocks);
    authService = module.get(AuthService);
    usersService = mocks.usersService;
    verificationTokenRepository = mocks.verificationTokenRepository;
  });

  it('marks user as confirmed and token as used for a valid token', async () => {
    const rawToken = 'a'.repeat(64);
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');
    const user = makeUser({ id: 'u1', is_confirmed: false });
    const record = makeVerificationToken({
      token_hash: tokenHash,
      type: VerificationTokenType.EMAIL_CONFIRMATION,
      used_at: null,
      expires_at: new Date(Date.now() + 60_000),
      user,
    });

    verificationTokenRepository.findOne.mockResolvedValue(record);

    await authService.confirm(rawToken);

    expect(record.used_at).toBeInstanceOf(Date);
    expect(user.is_confirmed).toBe(true);
    expect(verificationTokenRepository.save).toHaveBeenCalledWith(record);
    expect(usersService.save).toHaveBeenCalledWith(user);
  });

  it('throws InvalidTokenException when token is not found', async () => {
    verificationTokenRepository.findOne.mockResolvedValue(null);

    await expect(authService.confirm('nonexistent-token')).rejects.toThrow(
      InvalidTokenException,
    );
  });

  it('throws TokenExpiredException when token is expired', async () => {
    const rawToken = 'b'.repeat(64);
    const record = makeVerificationToken({
      token_hash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      type: VerificationTokenType.EMAIL_CONFIRMATION,
      used_at: null,
      expires_at: new Date(Date.now() - 1000),
      user: makeUser({ id: 'u1', is_confirmed: false }),
    });

    verificationTokenRepository.findOne.mockResolvedValue(record);

    await expect(authService.confirm(rawToken)).rejects.toThrow(
      TokenExpiredException,
    );
  });
});

describe('AuthService — resendConfirmation', () => {
  let authService: AuthService;
  let usersService: UsersServiceMock;
  let mailService: MailServiceMock;
  let verificationTokenRepository: RepositoryMock<VerificationToken>;

  beforeEach(async () => {
    const mocks = createAuthServiceMocks();
    const module = await buildTestModule(mocks);
    authService = module.get(AuthService);
    usersService = mocks.usersService;
    mailService = mocks.mailService;
    verificationTokenRepository = mocks.verificationTokenRepository;
  });

  it('returns silently when email is not found', async () => {
    usersService.findByEmailWithChannel.mockResolvedValue(null);

    await expect(
      authService.resendConfirmation('unknown@example.com'),
    ).resolves.toBeUndefined();
    expect(mailService.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  it('returns silently when user is already confirmed', async () => {
    usersService.findByEmailWithChannel.mockResolvedValue(
      makeUser({
        id: 'u1',
        is_confirmed: true,
        channel: makeChannel({ name: 'nick' }),
      }),
    );

    await expect(
      authService.resendConfirmation('confirmed@example.com'),
    ).resolves.toBeUndefined();
    expect(mailService.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  it('invalidates old tokens and sends a new confirmation email', async () => {
    const user = makeUser({
      id: 'u1',
      email: 'user@example.com',
      is_confirmed: false,
      channel: makeChannel({ name: 'nick' }),
    });
    usersService.findByEmailWithChannel.mockResolvedValue(user);

    const qbMock = createUpdateQueryBuilderMock();
    verificationTokenRepository.createQueryBuilder.mockReturnValue(qbMock);
    verificationTokenRepository.create.mockReturnValue(new VerificationToken());

    await authService.resendConfirmation('user@example.com');

    expect(qbMock.execute).toHaveBeenCalled();
    expect(verificationTokenRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: 'u1',
      }),
    );
    expect(mailService.sendConfirmationEmail).toHaveBeenCalledWith(
      'user@example.com',
      'nick',
      expect.any(String),
    );
  });
});

describe('AuthService — login', () => {
  let authService: AuthService;
  let usersService: UsersServiceMock;
  let refreshTokenRepository: RepositoryMock<RefreshToken>;
  let hashedTestPassword: string;

  beforeAll(async () => {
    hashedTestPassword = await argon2.hash('correctpassword');
  });

  beforeEach(async () => {
    const mocks = createAuthServiceMocks();
    const module = await buildTestModule(mocks);
    authService = module.get(AuthService);
    usersService = mocks.usersService;
    refreshTokenRepository = mocks.refreshTokenRepository;
  });

  it('throws InvalidCredentialsException when email is not found', async () => {
    usersService.findByEmail.mockResolvedValue(null);

    await expect(
      authService.login({
        email: 'nobody@example.com',
        password: 'password123',
      }),
    ).rejects.toThrow(InvalidCredentialsException);
  });

  it('throws InvalidCredentialsException when password is wrong', async () => {
    usersService.findByEmail.mockResolvedValue(
      makeUser({
        id: 'u1',
        email: 'user@example.com',
        password: hashedTestPassword,
        is_confirmed: true,
      }),
    );

    await expect(
      authService.login({
        email: 'user@example.com',
        password: 'wrongpassword',
      }),
    ).rejects.toThrow(InvalidCredentialsException);
  });

  it('throws EmailNotConfirmedException when user is not confirmed', async () => {
    usersService.findByEmail.mockResolvedValue(
      makeUser({
        id: 'u1',
        email: 'user@example.com',
        password: hashedTestPassword,
        is_confirmed: false,
      }),
    );

    await expect(
      authService.login({
        email: 'user@example.com',
        password: 'correctpassword',
      }),
    ).rejects.toThrow(EmailNotConfirmedException);
  });

  it('returns access_token and refresh_token on valid credentials', async () => {
    usersService.findByEmail.mockResolvedValue(
      makeUser({
        id: 'u1',
        email: 'user@example.com',
        password: hashedTestPassword,
        is_confirmed: true,
      }),
    );

    const result = await authService.login({
      email: 'user@example.com',
      password: 'correctpassword',
    });

    expect(result.access_token).toBeDefined();
    expect(result.refresh_token).toBeDefined();
    expect(typeof result.access_token).toBe('string');
    expect(typeof result.refresh_token).toBe('string');
    expect(refreshTokenRepository.save).toHaveBeenCalled();
  });
});

describe('AuthService — refresh', () => {
  let authService: AuthService;
  let refreshTokenRepository: RepositoryMock<RefreshToken>;

  const mockUser = makeUser({ id: 'u1', email: 'user@example.com' });
  const rawToken = 'a'.repeat(64);
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  beforeEach(async () => {
    const mocks = createAuthServiceMocks();
    const module = await buildTestModule(mocks);
    authService = module.get(AuthService);
    refreshTokenRepository = mocks.refreshTokenRepository;
  });

  it('throws InvalidTokenException when token is not found', async () => {
    refreshTokenRepository.findOne.mockResolvedValue(null);

    await expect(authService.refresh(rawToken)).rejects.toThrow(
      InvalidTokenException,
    );
  });

  it('throws TokenExpiredException when token is expired', async () => {
    const record = makeRefreshToken({
      token_hash: tokenHash,
      family: 'family-uuid',
      user_id: 'u1',
      user: mockUser,
      expires_at: new Date(Date.now() - 1000),
      revoked_at: null,
    });
    refreshTokenRepository.findOne.mockResolvedValue(record);

    await expect(authService.refresh(rawToken)).rejects.toThrow(
      TokenExpiredException,
    );
  });

  it('rotates token: revokes old, persists new, returns both tokens', async () => {
    const record = makeRefreshToken({
      token_hash: tokenHash,
      family: 'family-uuid',
      user_id: 'u1',
      user: mockUser,
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null,
    });
    refreshTokenRepository.findOne.mockResolvedValue(record);
    refreshTokenRepository.create.mockReturnValue(new RefreshToken());

    const result = await authService.refresh(rawToken);

    expect(record.revoked_at).toBeInstanceOf(Date);
    expect(refreshTokenRepository.save).toHaveBeenCalledWith(record);
    expect(refreshTokenRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'family-uuid', user_id: 'u1' }),
    );
    expect(result.access_token).toBeDefined();
    expect(result.refresh_token).toBeDefined();
    expect(result.refresh_token).not.toBe(rawToken);
  });

  it('returns new access token without revoking family when reuse is within grace period', async () => {
    const revokedAt = new Date(Date.now() - 5_000);
    const record = makeRefreshToken({
      token_hash: tokenHash,
      family: 'family-uuid',
      user_id: 'u1',
      user: mockUser,
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: revokedAt,
    });
    refreshTokenRepository.findOne.mockResolvedValue(record);

    const result = await authService.refresh(rawToken);

    expect(result.access_token).toBeDefined();
    expect(result.refresh_token).toBe(rawToken);
    expect(refreshTokenRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('revokes entire family and throws TokenReuseDetectedException beyond grace period', async () => {
    const revokedAt = new Date(Date.now() - 15_000);
    const record = makeRefreshToken({
      token_hash: tokenHash,
      family: 'family-uuid',
      user_id: 'u1',
      user: mockUser,
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: revokedAt,
    });
    refreshTokenRepository.findOne.mockResolvedValue(record);

    const qbMock = createUpdateQueryBuilderMock();
    refreshTokenRepository.createQueryBuilder.mockReturnValue(qbMock);

    await expect(authService.refresh(rawToken)).rejects.toThrow(
      TokenReuseDetectedException,
    );

    expect(qbMock.execute).toHaveBeenCalled();
    expect(qbMock.where).toHaveBeenCalledWith('family = :family', {
      family: 'family-uuid',
    });
  });
});

describe('AuthService — logout', () => {
  let authService: AuthService;
  let refreshTokenRepository: RepositoryMock<RefreshToken>;

  beforeEach(async () => {
    const mocks = createAuthServiceMocks();
    const module = await buildTestModule(mocks);
    authService = module.get(AuthService);
    refreshTokenRepository = mocks.refreshTokenRepository;
  });

  it('revokes all active refresh tokens for the user', async () => {
    const qbMock = createUpdateQueryBuilderMock();
    refreshTokenRepository.createQueryBuilder.mockReturnValue(qbMock);

    await authService.logout('user-id-123');

    expect(qbMock.set).toHaveBeenCalledWith({ revoked_at: anyDate });
    expect(qbMock.where).toHaveBeenCalledWith('user_id = :userId', {
      userId: 'user-id-123',
    });
    expect(qbMock.andWhere).toHaveBeenCalledWith('revoked_at IS NULL');
    expect(qbMock.execute).toHaveBeenCalled();
  });
});

describe('AuthService — forgotPassword', () => {
  let authService: AuthService;
  let usersService: UsersServiceMock;
  let mailService: MailServiceMock;
  let verificationTokenRepository: RepositoryMock<VerificationToken>;

  beforeEach(async () => {
    const mocks = createAuthServiceMocks();
    const module = await buildTestModule(mocks);
    authService = module.get(AuthService);
    usersService = mocks.usersService;
    mailService = mocks.mailService;
    verificationTokenRepository = mocks.verificationTokenRepository;
  });

  it('returns silently when email is not registered', async () => {
    usersService.findByEmailWithChannel.mockResolvedValue(null);

    await expect(
      authService.forgotPassword('unknown@example.com'),
    ).resolves.toBeUndefined();
    expect(mailService.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('invalidates previous reset tokens and sends a reset email', async () => {
    const user = makeUser({
      id: 'u1',
      email: 'user@example.com',
      channel: makeChannel({ name: 'nick' }),
    });
    usersService.findByEmailWithChannel.mockResolvedValue(user);

    const qbMock = createUpdateQueryBuilderMock();
    verificationTokenRepository.createQueryBuilder.mockReturnValue(qbMock);
    verificationTokenRepository.create.mockReturnValue(new VerificationToken());

    await authService.forgotPassword('user@example.com');

    expect(qbMock.execute).toHaveBeenCalled();
    expect(qbMock.andWhere).toHaveBeenCalledWith('type = :type', {
      type: VerificationTokenType.PASSWORD_RESET,
    });
    expect(verificationTokenRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VerificationTokenType.PASSWORD_RESET,
        user_id: 'u1',
      }),
    );
    expect(mailService.sendPasswordResetEmail).toHaveBeenCalledWith(
      'user@example.com',
      'nick',
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  });
});

describe('AuthService — resetPassword', () => {
  let authService: AuthService;
  let usersService: UsersServiceMock;
  let verificationTokenRepository: RepositoryMock<VerificationToken>;
  let refreshTokenRepository: RepositoryMock<RefreshToken>;

  beforeEach(async () => {
    const mocks = createAuthServiceMocks();
    const module = await buildTestModule(mocks);
    authService = module.get(AuthService);
    usersService = mocks.usersService;
    verificationTokenRepository = mocks.verificationTokenRepository;
    refreshTokenRepository = mocks.refreshTokenRepository;
  });

  it('throws InvalidTokenException when token is not found', async () => {
    verificationTokenRepository.findOne.mockResolvedValue(null);

    await expect(
      authService.resetPassword('badtoken', 'newpassword'),
    ).rejects.toThrow(InvalidTokenException);
  });

  it('throws TokenExpiredException when token is expired', async () => {
    const rawToken = 'c'.repeat(64);
    const record = makeVerificationToken({
      token_hash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      type: VerificationTokenType.PASSWORD_RESET,
      used_at: null,
      expires_at: new Date(Date.now() - 1000),
      user: makeUser({ id: 'u1', password: 'oldhash' }),
    });
    verificationTokenRepository.findOne.mockResolvedValue(record);

    await expect(
      authService.resetPassword(rawToken, 'newpassword'),
    ).rejects.toThrow(TokenExpiredException);
  });

  it('hashes the new password, marks token used, and revokes refresh tokens', async () => {
    const rawToken = 'd'.repeat(64);
    const user = makeUser({ id: 'u1', password: 'oldhash' });
    const record = makeVerificationToken({
      token_hash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      type: VerificationTokenType.PASSWORD_RESET,
      used_at: null,
      expires_at: new Date(Date.now() + 60_000),
      user,
    });
    verificationTokenRepository.findOne.mockResolvedValue(record);

    const qbMock = createUpdateQueryBuilderMock();
    refreshTokenRepository.createQueryBuilder.mockReturnValue(qbMock);

    await authService.resetPassword(rawToken, 'newplaintext');

    expect(record.used_at).toBeInstanceOf(Date);
    expect(user.password).not.toBe('oldhash');
    expect(user.password).toMatch(/^\$argon2/);
    expect(verificationTokenRepository.save).toHaveBeenCalledWith(record);
    expect(usersService.save).toHaveBeenCalledWith(user);
    expect(qbMock.where).toHaveBeenCalledWith('user_id = :userId', {
      userId: 'u1',
    });
    expect(qbMock.execute).toHaveBeenCalled();
  });
});
