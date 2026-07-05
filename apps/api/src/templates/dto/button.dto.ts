import { IsIn, IsOptional, IsString, IsNotEmpty, MaxLength, IsUrl } from 'class-validator';
import type { ButtonType } from '@wa-engine/shared';

const BUTTON_TYPES = ['QUICK_REPLY', 'URL', 'CALL'] as const;

export class ButtonDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsIn(BUTTON_TYPES)
  type!: ButtonType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  label!: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  url?: string;

  // E.164 format is enforced by validateButtons() (needs to know the button's
  // type to know whether phoneNumber is required) — class-validator alone
  // can't express "required only if type === CALL" without a custom decorator.
  @IsOptional()
  @IsString()
  phoneNumber?: string;
}
