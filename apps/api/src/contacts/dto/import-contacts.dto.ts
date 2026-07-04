import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ImportContactItemDto } from './import-contact-item.dto';

export class ImportContactsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportContactItemDto)
  contacts!: ImportContactItemDto[];

  @IsOptional()
  @IsString()
  smartListId?: string;
}
