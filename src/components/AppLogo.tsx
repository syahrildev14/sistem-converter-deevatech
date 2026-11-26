import Image from 'next/image';
import logo from '@/assets/logo.jpg';

export function AppLogo({ size = 40 }: { size?: number }) {
  return (
    <Image
      src={logo}
      alt="Office Media Converter"
      width={size}
      height={size}
      priority
      unoptimized
      className="shrink-0 rounded-xl object-cover"
    />
  );
}
