import { BadRequestException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { createAccessInquirySchema } from './access-inquiries.dto';
import { AccessInquiriesService } from './access-inquiries.service';

const user: AuthUser = { userId: 3, username: 'agent', isAdmin: false, userGroupId: 12 };

function setup() {
  const prisma = {
    document: { findUnique: jest.fn().mockResolvedValue({ documentId: 7 }) },
    permissionLevel: {
      findUnique: jest.fn(({ where }: { where: { permissionLevelId: number } }) =>
        Promise.resolve(where.permissionLevelId <= 5 ? { permissionLevelId: where.permissionLevelId } : null),
      ),
    },
    documentAccessInquiry: { create: jest.fn().mockResolvedValue({ documentAccessInquiryId: 1 }) },
  };
  const tabs = { grantPermission: jest.fn() };
  const service = new AccessInquiriesService(prisma as never, tabs as never);
  return { service, prisma };
}

describe('AccessInquiriesService.create', () => {
  it('refuse une demande du niveau « Denied » (elle ne pourrait jamais être acceptée)', async () => {
    const { service, prisma } = setup();
    await expect(
      service.create({ documentId: 7, permissionLevelId: 1, motive: 'audit' }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.documentAccessInquiry.create).not.toHaveBeenCalled();
  });

  it('enregistre une demande valide au nom de l’acteur courant', async () => {
    const { service, prisma } = setup();
    await service.create(
      { documentId: 7, permissionLevelId: 2, motive: 'audit', startDate: '2026-03-01' },
      user,
    );
    expect(prisma.documentAccessInquiry.create).toHaveBeenCalledWith({
      data: {
        documentId: 7,
        userGroupId: 12,
        permissionLevelId: 2,
        motive: 'audit',
        startDate: new Date('2026-03-01'),
        endDate: null,
      },
    });
  });

  it('niveau inconnu → 400', async () => {
    const { service } = setup();
    await expect(
      service.create({ documentId: 7, permissionLevelId: 42, motive: 'audit' }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('createAccessInquirySchema', () => {
  const base = { documentId: 7, permissionLevelId: 2, motive: 'audit' };

  it.each(['2026-13-01', '2026-02-31'])('refuse le jour inexistant %s', (d) => {
    expect(createAccessInquirySchema.safeParse({ ...base, startDate: d }).success).toBe(false);
  });

  it('refuse une fin antérieure au début', () => {
    expect(
      createAccessInquirySchema.safeParse({ ...base, startDate: '2026-03-02', endDate: '2026-03-01' })
        .success,
    ).toBe(false);
  });

  it('refuse un motif vide', () => {
    expect(createAccessInquirySchema.safeParse({ ...base, motive: '   ' }).success).toBe(false);
  });

  it('accepte une demande sans période', () => {
    expect(createAccessInquirySchema.safeParse(base).success).toBe(true);
  });
});
