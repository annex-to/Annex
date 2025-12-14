-- DropForeignKey
ALTER TABLE "EncoderAssignment" DROP CONSTRAINT "EncoderAssignment_encoderId_fkey";

-- AddForeignKey
ALTER TABLE "EncoderAssignment" ADD CONSTRAINT "EncoderAssignment_encoderId_fkey" FOREIGN KEY ("encoderId") REFERENCES "RemoteEncoder"("encoderId") ON DELETE CASCADE ON UPDATE CASCADE;
