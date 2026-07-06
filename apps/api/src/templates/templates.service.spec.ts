import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TemplatesService } from './templates.service';
import { PrismaService } from '../common/prisma/prisma.service';

const mockTemplate = {
  id: 't-1',
  name: 'Welcome',
  body: '{Hi|Hello} {name}!',
  mediaUrl: null,
  category: 'marketing',
  buttons: null,
  createdAt: new Date(),
};

describe('TemplatesService', () => {
  let service: TemplatesService;

  const mockPrisma = {
    template: {
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  } as unknown as PrismaService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        TemplatesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(TemplatesService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('creates and returns a template', async () => {
      (mockPrisma.template.create as jest.Mock).mockResolvedValue(mockTemplate);

      const result = await service.create({
        name: 'Welcome',
        body: '{Hi|Hello} {name}!',
        category: 'marketing',
      });

      expect(result).toMatchObject({ id: 't-1', name: 'Welcome' });
      expect(mockPrisma.template.create).toHaveBeenCalledWith({
        data: { name: 'Welcome', body: '{Hi|Hello} {name}!', category: 'marketing' },
      });
    });
  });

  describe('findAll', () => {
    it('returns templates ordered by createdAt desc', async () => {
      (mockPrisma.template.findMany as jest.Mock).mockResolvedValue([mockTemplate]);

      const result = await service.findAll();

      expect(result).toHaveLength(1);
      expect(mockPrisma.template.findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('buttons validation', () => {
    it('creates a template with a valid button array', async () => {
      (mockPrisma.template.create as jest.Mock).mockResolvedValue(mockTemplate);
      const buttons = [{ id: 'b1', type: 'QUICK_REPLY' as const, label: 'Yes' }];

      await service.create({ name: 'Welcome', body: 'Hi', buttons });

      expect(mockPrisma.template.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ buttons }),
      });
    });

    it('rejects more than 3 buttons (lenient ANY-mode cap) on create', async () => {
      const buttons = [1, 2, 3, 4].map((n) => ({ id: `b${n}`, type: 'QUICK_REPLY' as const, label: `B${n}` }));

      await expect(service.create({ name: 'Welcome', body: 'Hi', buttons })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.template.create).not.toHaveBeenCalled();
    });

    it('rejects an invalid button array on update', async () => {
      const buttons = [{ id: 'b1', type: 'URL' as const, label: 'Visit' }]; // missing url

      await expect(service.update('t-1', { buttons })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.template.update).not.toHaveBeenCalled();
    });

    it('updates a template with a valid button array', async () => {
      (mockPrisma.template.update as jest.Mock).mockResolvedValue(mockTemplate);
      const buttons = [{ id: 'b1', type: 'CALL' as const, label: 'Call us', phoneNumber: '+14155552671' }];

      await service.update('t-1', { buttons });

      expect(mockPrisma.template.update).toHaveBeenCalledWith({
        where: { id: 't-1' },
        data: expect.objectContaining({ buttons }),
      });
    });
  });

  describe('carousel validation + mode mutual exclusivity', () => {
    const cards = [
      { id: 'c1', mediaUrl: 'https://example.com/a.jpg', body: 'Card A', buttons: [] },
      { id: 'c2', mediaUrl: 'https://example.com/b.jpg', body: 'Card B', buttons: [] },
    ];

    it('creates a template with a valid carousel and nulls buttons/mediaUrl', async () => {
      (mockPrisma.template.create as jest.Mock).mockResolvedValue(mockTemplate);

      await service.create({ name: 'Carousel', body: 'Intro', carouselCards: cards });

      expect(mockPrisma.template.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          carouselCards: cards,
          buttons: expect.anything(), // Prisma.JsonNull sentinel
          mediaUrl: null,
        }),
      });
    });

    it('rejects a carousel with fewer than 2 cards on create', async () => {
      await expect(
        service.create({ name: 'Carousel', body: 'Intro', carouselCards: [cards[0]!] }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.template.create).not.toHaveBeenCalled();
    });

    it('switching an existing carousel template to single-mode nulls carouselCards even with zero buttons', async () => {
      (mockPrisma.template.update as jest.Mock).mockResolvedValue(mockTemplate);

      // Frontend always sends `buttons` (even []) when saving in SINGLE mode, and omits
      // carouselCards entirely — presence, not truthiness, is what buildModeFields keys off.
      await service.update('t-1', { buttons: [], mediaUrl: 'https://example.com/new.jpg' });

      expect(mockPrisma.template.update).toHaveBeenCalledWith({
        where: { id: 't-1' },
        data: expect.objectContaining({
          buttons: [],
          carouselCards: expect.anything(), // Prisma.JsonNull sentinel
          mediaUrl: 'https://example.com/new.jpg',
        }),
      });
    });

    it('an update that only touches unrelated fields leaves buttons/carouselCards/mediaUrl untouched', async () => {
      (mockPrisma.template.update as jest.Mock).mockResolvedValue(mockTemplate);

      await service.update('t-1', { name: 'Renamed' });

      const call = (mockPrisma.template.update as jest.Mock).mock.calls[0][0];
      expect(call.data).not.toHaveProperty('buttons');
      expect(call.data).not.toHaveProperty('carouselCards');
    });
  });
});
