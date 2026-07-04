import { Test } from '@nestjs/testing';
import { ContactsService } from './contacts.service';
import { PrismaService } from '../common/prisma/prisma.service';

const mockContact = {
  id: 'c-1',
  phone: '+1234567890',
  name: 'Alice',
  city: null,
  vars: null,
  tags: [],
  valid: true,
  createdAt: new Date(),
};

describe('ContactsService', () => {
  let service: ContactsService;

  const mockPrisma = {
    contact: {
      upsert: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn(),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    smartListContact: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as PrismaService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ContactsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(ContactsService);
    jest.clearAllMocks();
  });

  describe('importContacts', () => {
    it('bulk-inserts valid unique contacts via createMany and returns counts', async () => {
      (mockPrisma.contact.createMany as jest.Mock).mockResolvedValue({ count: 2 });

      const result = await service.importContacts({
        contacts: [
          { phone: '+1234567890', name: 'Alice' },
          { phone: '+15551234567', name: 'Bob' },
        ],
      });

      expect(result).toEqual({ imported: 2, skipped: 0, duplicates: 0 });
      expect(mockPrisma.contact.createMany).toHaveBeenCalledTimes(1);
      const arg = (mockPrisma.contact.createMany as jest.Mock).mock.calls[0][0];
      expect(arg.skipDuplicates).toBe(true);
      expect(arg.data).toHaveLength(2);
    });

    it('skips (does not reject) rows with a blank/invalid phone', async () => {
      (mockPrisma.contact.createMany as jest.Mock).mockResolvedValue({ count: 1 });

      const result = await service.importContacts({
        contacts: [
          { phone: '+1234567890' },
          { phone: 'not-a-phone' },
          { phone: '' },
          { phone: '123' },            // too short
          { phone: '+0987654321' },    // leading zero after + → invalid E.164
        ],
      });

      expect(result).toEqual({ imported: 1, skipped: 4, duplicates: 0 });
    });

    it('salvages messy phone formats (spaces/dashes, no +, and a 00 prefix)', async () => {
      (mockPrisma.contact.createMany as jest.Mock).mockResolvedValue({ count: 3 });

      await service.importContacts({
        contacts: [
          { phone: '971 50 123 4567' },   // no + → +971501234567
          { phone: '00447911123456' },    // 00 prefix → +447911123456
          { phone: '+1-415-555-2671' },   // dashes → +14155552671
        ],
      });

      const data = (mockPrisma.contact.createMany as jest.Mock).mock.calls[0][0].data as Array<{ phone: string }>;
      expect(data.map((d) => d.phone)).toEqual(['+971501234567', '+447911123456', '+14155552671']);
    });

    it('dedupes duplicate phones within the same file', async () => {
      (mockPrisma.contact.createMany as jest.Mock).mockResolvedValue({ count: 1 });

      const result = await service.importContacts({
        contacts: [
          { phone: '+1234567890', name: 'First' },
          { phone: '+1234567890', name: 'Dup' },
        ],
      });

      expect(result).toEqual({ imported: 1, skipped: 0, duplicates: 1 });
      expect((mockPrisma.contact.createMany as jest.Mock).mock.calls[0][0].data).toHaveLength(1);
    });

    it('counts already-existing contacts (skipped by the DB) as duplicates', async () => {
      // 2 unique valid rows, but createMany inserts only 1 (the other already existed)
      (mockPrisma.contact.createMany as jest.Mock).mockResolvedValue({ count: 1 });

      const result = await service.importContacts({
        contacts: [{ phone: '+1234567890' }, { phone: '+15551234567' }],
      });

      expect(result).toEqual({ imported: 1, skipped: 0, duplicates: 1 });
    });

    it('adds every valid contact to the target smart list when smartListId is given', async () => {
      (mockPrisma.contact.createMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.contact.findMany as jest.Mock).mockResolvedValue([{ id: 'c-1' }, { id: 'c-2' }]);

      await service.importContacts({
        contacts: [{ phone: '+1234567890' }, { phone: '+15551234567' }],
        smartListId: 'list-1',
      });

      expect(mockPrisma.smartListContact.createMany).toHaveBeenCalledWith({
        data: [
          { smartListId: 'list-1', contactId: 'c-1' },
          { smartListId: 'list-1', contactId: 'c-2' },
        ],
        skipDuplicates: true,
      });
    });
  });

  describe('listContacts', () => {
    it('returns paginated envelope with data and total', async () => {
      (mockPrisma.contact.findMany as jest.Mock).mockResolvedValue([mockContact]);
      (mockPrisma.contact.count as jest.Mock).mockResolvedValue(42);

      const result = await service.listContacts();

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({ phone: '+1234567890' });
      expect(result.total).toBe(42);
      expect(result.skip).toBe(0);
      expect(result.take).toBe(50);
    });

    it('caps take at 200', async () => {
      (mockPrisma.contact.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.contact.count as jest.Mock).mockResolvedValue(0);

      const result = await service.listContacts({ take: 9999 });

      expect(result.take).toBe(200);
    });
  });

  describe('validateContacts (Layer 5 E.164 validator)', () => {
    it('marks invalid phones as valid=false and valid phones as valid=true', async () => {
      const contacts = [
        { id: 'c1', phone: '+12025550191' },  // valid
        { id: 'c2', phone: '12025550191' },   // invalid — missing +
        { id: 'c3', phone: '+447911123456' }, // valid
        { id: 'c4', phone: 'not-a-phone' },   // invalid
      ];
      (mockPrisma.contact.findMany as jest.Mock).mockResolvedValue(contacts);
      (mockPrisma.contact.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      const result = await service.validateContacts();

      expect(result).toEqual({ valid: 2, invalid: 2 });

      // Invalid contacts marked false
      expect(mockPrisma.contact.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['c2', 'c4'] } },
        data: { valid: false },
      });

      // Valid contacts marked true
      expect(mockPrisma.contact.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['c1', 'c3'] } },
        data: { valid: true },
      });
    });

    it('returns { valid: 0, invalid: 0 } when no contacts exist', async () => {
      (mockPrisma.contact.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.validateContacts();

      expect(result).toEqual({ valid: 0, invalid: 0 });
      expect(mockPrisma.contact.updateMany).not.toHaveBeenCalled();
    });

    it('skips the invalid updateMany when all contacts are valid', async () => {
      (mockPrisma.contact.findMany as jest.Mock).mockResolvedValue([
        { id: 'c1', phone: '+12025550191' },
      ]);
      (mockPrisma.contact.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const result = await service.validateContacts();

      expect(result).toEqual({ valid: 1, invalid: 0 });
      // Only one updateMany call (for valid)
      expect(mockPrisma.contact.updateMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.contact.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['c1'] } },
        data: { valid: true },
      });
    });
  });
});
