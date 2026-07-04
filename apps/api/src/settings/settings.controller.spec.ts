import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { SettingsController } from './settings.controller';
import { SettingsService, type EngineSettings } from './settings.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { BAILEYS_QUEUE, CLOUD_API_QUEUE, DLQ_QUEUE } from '../queue/queue.constants';

const CURRENT: EngineSettings = {
  meanMs: 120_000,
  stdDevMs: 35_000,
  floorMs: 60_000,
  ceilingMs: 480_000,
  typingMs: 3_000,
  dailyLimit: 1_000,
  dryRun: false,
};

const mockSettings = {
  getEngineSettings: jest.fn().mockReturnValue(CURRENT),
  set: jest.fn().mockResolvedValue(undefined),
};

const noopQueue = {};

describe('SettingsController — antiban validation', () => {
  let controller: SettingsController;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSettings.getEngineSettings.mockReturnValue(CURRENT);

    const module = await Test.createTestingModule({
      providers: [
        SettingsController,
        { provide: SettingsService, useValue: mockSettings },
        { provide: PrismaService, useValue: {} },
        { provide: getQueueToken(BAILEYS_QUEUE), useValue: noopQueue },
        { provide: getQueueToken(CLOUD_API_QUEUE), useValue: noopQueue },
        { provide: getQueueToken(DLQ_QUEUE), useValue: noopQueue },
      ],
    }).compile();

    controller = module.get(SettingsController);
  });

  it('rejects floor >= mean (merged with current settings)', async () => {
    // floorMs 200000 with current mean 120000 → floor > mean
    await expect(controller.patchEngine({ floorMs: 200_000 })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockSettings.set).not.toHaveBeenCalled();
  });

  it('rejects mean >= ceiling', async () => {
    await expect(controller.patchEngine({ meanMs: 500_000 })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockSettings.set).not.toHaveBeenCalled();
  });

  it('rejects stdDev greater than mean', async () => {
    await expect(controller.patchEngine({ stdDevMs: 130_000 })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockSettings.set).not.toHaveBeenCalled();
  });

  it('accepts a valid partial patch and persists it', async () => {
    await controller.patchEngine({ meanMs: 150_000, floorMs: 90_000 });
    expect(mockSettings.set).toHaveBeenCalledWith('DELAY_MEAN_MS', '150000');
    expect(mockSettings.set).toHaveBeenCalledWith('DELAY_FLOOR_MS', '90000');
  });

  it('accepts a full valid ordering floor < mean < ceiling', async () => {
    await expect(
      controller.patchEngine({ floorMs: 45_000, meanMs: 90_000, ceilingMs: 300_000, stdDevMs: 30_000 }),
    ).resolves.toBeDefined();
  });
});
