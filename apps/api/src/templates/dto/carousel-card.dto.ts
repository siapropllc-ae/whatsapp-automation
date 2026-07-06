import { IsArray, IsIn, IsNotEmpty, IsOptional, IsString, IsUrl, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { CarouselCardDef } from '@wa-engine/shared';
import { ButtonDto } from './button.dto';

const MEDIA_TYPES = ['IMAGE', 'VIDEO'] as const;

export class CarouselCardDto implements CarouselCardDef {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsUrl({ require_tld: false })
  mediaUrl!: string;

  @IsOptional()
  @IsIn(MEDIA_TYPES)
  mediaType?: 'IMAGE' | 'VIDEO';

  @IsString()
  @IsNotEmpty()
  body!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ButtonDto)
  buttons!: ButtonDto[];
}
