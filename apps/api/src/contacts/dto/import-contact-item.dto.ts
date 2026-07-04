import { IsArray, IsEnum, IsObject, IsOptional, IsString } from 'class-validator';
import { LeadTemp } from '@prisma/client';

/**
 * Permissive item shape for BULK import only. Unlike ContactItemDto (used for single
 * create), this does NOT enforce the E.164 regex at the DTO layer — a single bad phone
 * in a 500-row batch must not 400 the entire chunk. The service normalizes and validates
 * each phone individually and skips (rather than rejects) the invalid ones.
 */
export class ImportContactItemDto {
  @IsString()
  phone!: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  interest?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsEnum(LeadTemp)
  leadTemp?: LeadTemp;

  @IsOptional()
  @IsObject()
  vars?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
