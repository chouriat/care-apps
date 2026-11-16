import { useRouter } from 'expo-router';
import { requestMedsReload } from '../../src/features/meds/refresh';
import {
  PrescriptionScanScreen,
  type PrescriptionScanScreenProps,
} from '../../src/features/meds/scan';

export default function MedsScanRoute(props: PrescriptionScanScreenProps = {}) {
  const router = useRouter();

  // The Meds tab opens this screen with a push, so the Meds tab is still underneath: go back to
  // it. Replacing would stack a second copy of the tabs on top of the first one, and the back
  // button would then show the old list. Opened from a link with nothing underneath: open Meds.
  const backToMeds = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/meds' as never);
    }
  };

  return (
    <PrescriptionScanScreen
      {...props}
      onNavigateSignIn={
        props.onNavigateSignIn ??
        (() => {
          router.replace('/(auth)/sign-in' as never);
        })
      }
      onNavigateManualEntry={props.onNavigateManualEntry ?? backToMeds}
      onSaved={
        props.onSaved ??
        (() => {
          requestMedsReload();
          backToMeds();
        })
      }
    />
  );
}
