# Faz 6: sunucuda formül hesaplama

Durum: kullanıcı kararıyla ayrı geliştirme fazı. Formül yazma Faz 5'tedir; [ana planda](README.md) K1-06 ile kayıtlıdır.

## Hedef

Excel kurulmadan, açıkça seçilmiş bir formül kapsamının sonuçlarını hesaplayabilmek. Formülü saklamak, son kaydedilmiş sonucu okumak, güncel sonucu hesaplamak ve hesaplanan sonucu dosyaya kaydetmek ayrı yeteneklerdir.

## Kapsam

| Kimlik | İhtiyaç                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------- |
| F6-01  | İlk desteklenecek işleç ve işlev ailelerini gerçek kullanım örnekleriyle belirlemek.                    |
| F6-02  | Hücre, aralık, sayfa ve desteklenen adlandırılmış alan bağımlılıklarını izlemek.                        |
| F6-03  | Değişen girdilerden etkilenen sonuçları, desteklenen kapsamda doğru hesaplamak.                         |
| F6-04  | Boş, metin, sayı, mantıksal değer, tarih/saat ve hata anlamlarını hesaplamada tanımlamak.               |
| F6-05  | Desteklenmeyen işlev, döngüsel başvuru, dış kaynak ihtiyacı ve limit aşımını sonuçtan ayrı ifade etmek. |
| F6-06  | Kullanıcıya gösterilen hesaplanmış sonuç ile çıktıda saklanan hesaplama durumunu ayırt etmek.           |
| F6-07  | Sonuçları gerçek Excel'den alınmış veya başka bağımsız kaynaktan doğrulanmış örneklerle karşılaştırmak. |

Başlangıç adayları aritmetik, temel toplam/sayma, koşullu işlemler ve basit aramalardır. Bu liste henüz onaylanmış işlev kapsamı değildir; yüzlerce işlevi ilk teslimde destekleme taahhüdü yoktur.

## Kodlama iş paketleri

1. Formül aileleri, veri anlamları, hata davranışları ve destek kapsamı için bağımsız beklenen sonuçlar hazırlamak.
2. Hesaplama yaklaşımını, uyumluluk, dağıtım ve kaynak ihtiyaçlarıyla değerlendirmek; yalnızca formül yazma motoruyla aynı olmak zorunda kabul etmemek.
3. Seçilmiş işleçler, işlevler ve hücre bağımlılıklarını tamamlamak.
4. Desteklenmeyen ve bütçeyi aşan hesaplamayı güvenilir biçimde ayırmak; yanlış tahminle değer üretmemek.
5. Hesaplama sonucunun gösterilmesi ve gerekiyorsa dosyada saklanması beklentisini tamamlamak.
6. Bağımsız örnekler, kaynak bütçesi ve mevcut formül yazma davranışıyla birlikte doğrulamak.

## Bağımlılıklar ve sınırlar

- Faz 5'in formül ve referans anlamı ile Faz 0'ın değer/bütçe kurallarına dayanır.
- Yeni bir çıktı sürümünde eski kaydedilmiş sonuçların güncel kabul edilip edilmeyeceği tanımlanmalıdır.
- Formül metninin doğru yazılması, sonucun doğru olduğunun kanıtı değildir.
- Yuvarlama, tarih sistemi, hata yayılımı, boş hücre ve metin dönüştürme gerçek uyumluluk ihtiyaçlarıdır.
- Dinamik diziler, değişken işlevler, dış çalışma kitabı başvuruları ve kullanıcı tanımlı işlevler ayrıca seçilir.
- Desteklenmeyen sonuç, bilinçli boş değerle aynı anlama gelmemelidir.

## Kabul senaryoları

- Temel aritmetik, toplam, koşullu hesap ve seçilmiş arama örnekleri bağımsız beklenen sonuçlarla örtüşür.
- Girdi değişikliği sonrasında desteklenen bağımlı sonuç doğru güncellenir.
- Formülün son kaydedilmiş sonucu, yeni girdilere rağmen yanlışlıkla güncel diye sunulmaz.
- Desteklenmeyen işlev ve döngüsel başvuru, hata/hesaplanamama bilgisiyle ayrılır.
- Aynı formülün boş, metin, tarih ve hata girdilerindeki sonuçları kabul edilmiş kuralları izler.
- Limit aşımı önceki dosya sürümünü bozmaz.
- Hesaplanmış değerlerin dosyada saklanması kapsama alınırsa yeniden açılışta da beklenen sonuçlar doğrulanır.

## Açık kararlar

A-12: işlev listesi, doğruluk/tolerans, tarih ve hata davranışı, bağımlılık, değişken işlevler ve sonuç saklama kapsamı. Kullanıcının ayrı faz kararı kesindir; motor ve destek ayrıntıları bu fazın uygulamasında seçilir.
