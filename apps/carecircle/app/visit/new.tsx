import { useLocalSearchParams, useRouter } from 'expo-router';
import { VisitNoteScreen, type VisitNoteScreenProps } from '../../src/features/visit';

export default function VisitNewRoute(props: VisitNoteScreenProps = {}) {
  const router = useRouter();
  const params = useLocalSearchParams<{ appointmentId?: string }>();
  const rawParam = Array.isArray(params.appointmentId)
    ? params.appointmentId[0]
    : params.appointmentId;
  const appointmentId = props.appointmentId ?? (rawParam?.trim() ? rawParam.trim() : null);

  const navigateBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/today' as never);
    }
  };

  return (
    <VisitNoteScreen
      {...props}
      appointmentId={appointmentId}
      onNavigateSignIn={
        props.onNavigateSignIn ??
        (() => {
          router.replace('/(auth)/sign-in' as never);
        })
      }
      onViewerRedirect={props.onViewerRedirect ?? navigateBack}
      onSaved={props.onSaved ?? navigateBack}
    />
  );
}
