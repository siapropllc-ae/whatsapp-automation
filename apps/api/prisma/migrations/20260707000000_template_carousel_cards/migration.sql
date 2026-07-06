-- Carousel templates: 2-10 cards, each with its own media/body/buttons.
-- Mutually exclusive with Template.buttons/mediaUrl, enforced in templates.service.ts.
ALTER TABLE "Template" ADD COLUMN "carouselCards" JSONB;
