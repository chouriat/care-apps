import { useRouter } from 'expo-router';
import {
  PrescriptionScanScreen,
  type PrescriptionScanScreenProps,
} from '../../src/features/meds/scan';

export default function MedsScanRoute(props: PrescriptionScanScreenProps = {}) {
  const router = useRouter();

  return (
    <PrescriptionScanScreen
      {...props}
      onNavigateSignIn={
        props.onNavigateSignIn ??
        (() => {
          router.replace('/(auth)/sign-in' as never);
        })
      }
      onNavigateManualEntry={
        props.onNavigateManualEntry ??
        (() => {
          router.replace('/(tabs)/meds' as never);
        })
      }
      onSaved={
        props.onSaved ??
        (() => {
          router.replace('/(tabs)/meds' as never);
        })
      }
    />
  );
}
